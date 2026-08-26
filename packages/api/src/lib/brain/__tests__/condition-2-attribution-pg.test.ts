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
 * §2 CORRECTION — two of the four verbs, chosen because they are the two that
 *    put a name somewhere. `supersede` (§2) MINTS a claim and attributes it;
 *    `re-authority` (§2b) is the only verb that writes a person onto an
 *    EXISTING claim's own provenance. Prod exercises `retract` only (four rows,
 *    2026-08-03 and 2026-08-24), and a retract writes nothing to the payload —
 *    so both arms here are unexercised in prod and a test is the only
 *    instrument for either.
 *
 *    §2 grew a second half at #5454, and it is the half the original missed.
 *    Attributing the claim is not naming the person: the handle is
 *    `user:<atlasUserId>`, and until #5454 it rendered *"cannot name this
 *    person"* — about the most directly resolvable identifier in the system.
 *    §2c walks the `supersedes` edge to answer the RETIRED side's question, and
 *    §2d covers the machine actor. Prod has no supersede-with-a-rendering to
 *    read (the first one ever ran on 2026-08-26, before this arm shipped), so
 *    these are again the only instrument.
 *
 *    ## §2/§2c/§2d — mutations verified red (2026-08-26)
 *
 *      1. `actor-identity.ts`: `derivableActor`'s `atlas-user` arm returns
 *         `null`. Red on §2 and §2c — the pre-#5454 behaviour, and the two
 *         assertions that exist to refuse it.
 *      2. `actor-identity.ts`: `derivableActor` never returns `machine`. Red on
 *         §2d only, which is the control §2d's own `slack:U-nobody` row makes:
 *         an absent row still means `opaque` for everyone else.
 *      3. `correction.ts`: `sourcePrincipal` becomes `` `human:${ctx.userId}` ``
 *         — the handle a capture-based fix would have keyed. Red on §2 and §2c,
 *         which is the byte-identity pin doing its job: the stored payload is
 *         compared as TEXT, and the actor it must hold is named.
 *
 *    ⚠️ Coverage bound: `pin` is tested by NEITHER instrument. It shares
 *    `applyVouch` with `re-authority` — same statement, same marker shape, only
 *    the key differs (`pinned` vs `reAuthority`) — so §2b covers the mechanism
 *    and not that verb's own wiring. `retract` is covered by the prod read and
 *    by `correction-audit-pg.test.ts`, not here.
 *
 * §3 MIGRATION — `admin-migrate.ts`'s region import. No region migration has
 *    ever run in us prod (`admin_action_log` holds no migration action type and
 *    no fact carries an imported producer), so a test is likewise the only
 *    instrument. Four cases: attribution on a well-formed bundle survives
 *    verbatim (§3a), and the three arms of the fix this issue produced —
 *    an unattributed `published` fact lands DRAFT (§3b), an unattributed draft
 *    is untouched (§3c), and a whitespace actor counts as no name (§3d).
 *
 * ## The lane §3b names, and how it was closed
 *
 * `lib/brain/sources.ts` argues a deliberate fail-open for `brain_episodes.source`:
 * the import restores an out-of-vocabulary value verbatim rather than refusing
 * the bundle, because refusing one episode strands the whole workspace at
 * cutover, and it LOGS the value so the lane is visible. #5424 asked whether
 * the ATTRIBUTION fields have an analogous lane. They did, and it was wider —
 * the bundle validator's only test on `provenance` is
 * `Object.keys(...).length > 0`, the payload was then bound verbatim, and no
 * log fired, so `{"note":"x"}` imported as a `published` claim naming nobody.
 *
 * The fix keeps the fail-open and removes the AUTHORITY. `bundleFactNamesAPerson`
 * demotes such a fact to `draft` and logs it; the bundle is still accepted,
 * because refusing it is what `sources.ts` rejected and the reasoning transfers
 * unchanged. §3b asserts BOTH halves — that validation still passes, and that
 * the row is not published — so a later tightening that moved the check into
 * `validateBundle` fails here rather than in a live cutover.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { withRequestContext } from "@atlas/api/lib/logger";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { correctFact } from "@atlas/api/lib/brain/correction";
import {
  identityFor,
  loadActorIdentities,
  type ActorIdentityReader,
} from "@atlas/api/lib/brain/actor-identity";
import { WAREHOUSE_PRODUCER_PRINCIPAL } from "@atlas/api/lib/brain/warehouse-producer";
import {
  RECONCILE_BLOCK_REASONS,
  reconcileFacts,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
// A file under `src/lib/**` importing from `api/routes/**`, which CLAUDE.md
// forbids. The carve-out is for TESTS: the ban exists so the data/helper layer
// does not drag auth/logger/middleware into every `lib/` consumer and break
// partial `mock.module()` mocks, and a test is not a `lib/` consumer.
// `lib/residency/__tests__/migrate-roundtrip-pg.test.ts` sets the precedent.
// The alternative — re-exporting the route's importer through a `lib/` shim
// used by nothing else — would move production code to satisfy a rule about
// production code, which is worse.
import {
  importBundle as importBundleWithCorrelationId,
  validateBundle,
} from "@atlas/api/api/routes/admin-migrate";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { ExportBundle } from "@useatlas/types";

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
    // Better Auth's `"user"`, stubbed to exactly the shape the identity read
    // joins (#5454). The auth migrations are skipped above, so without this the
    // `user:<id>` resolution has no relation to read and would degrade to
    // `opaque` — which is the OLD behaviour, and a test that asserted the fix
    // against a missing table would be asserting nothing.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL)`,
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Ada Lovelace', $2)
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR_ID, ACTOR_EMAIL],
    );
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
   * ONE transaction on the test pool, and the only one in this file.
   *
   * Both callers go through it — `poolTx` (which adapts it to the shape
   * `reconcileFacts` and `correctFact` take) and `runImport`. An earlier draft
   * hand-rolled `BEGIN`/`COMMIT`/`ROLLBACK` twice with DIFFERENT rollback
   * handling in each, which is the duplication worth removing: not because two
   * copies are ugly, but because the second copy had the bug.
   *
   * `client.release(rollbackErr)` is the load-bearing line, and it is the
   * ARGUMENT that matters rather than the call. `release()` returns the client
   * to the pool; `release(err)` DESTROYS it. Handing back a client still inside
   * an aborted transaction is what makes the NEXT query on it fail with
   * "current transaction is aborted" — a failure attributed to whichever test
   * the pool hands it to, not to the one that broke it.
   * `correction-audit-pg.test.ts:133` states the same reasoning where it was
   * learned.
   *
   * And the `.catch` rather than a bare `await`: a rollback-time failure must
   * not REPLACE the original error, or a test asserting on a named refusal sees
   * a pg error instead and fails naming the wrong thing.
   */
  async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let rollbackErr: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        // Logged, never swallowed: without this a failed ROLLBACK is invisible
        // and the fixture's real problem is a destroyed connection with no
        // stated reason.
        console.warn(`condition-2-pg: ROLLBACK failed — ${rollbackErr.message}`);
      });
      throw err;
    } finally {
      client.release(rollbackErr);
    }
  }

  /** {@link withTx}, in the shape `reconcileFacts` and `correctFact` accept. */
  const poolTx: ReconcileTransactionRunner = <T,>(
    fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
    }) => Promise<T>,
  ): Promise<T> =>
    withTx(async (client) =>
      fn({
        query: async (sql: string, params?: unknown[]) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as readonly unknown[] };
        },
      }),
    );

  /**
   * The identity read's handle, over the raw pool (#5454).
   *
   * Deliberately the SAME pool the sections seed through, so the resolution
   * runs against rows this file actually wrote — the point of asking a database
   * rather than a double is that the table's emptiness is a fact and not a
   * fixture.
   */
  const identityReader: ActorIdentityReader = {
    query: async (sql, params) => {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows as readonly unknown[], rowCount: res.rowCount };
    },
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

      // The stored payload, captured BEFORE anything reads it — AC3's baseline.
      const { rows: provRows } = await pool.query<{ p: string }>(
        `SELECT provenance::text AS p FROM brain_facts WHERE id = $1::uuid`,
        [replacementId],
      );
      const provenanceBefore = provRows[0]?.p;
      if (provenanceBefore === undefined) throw new Error("§2: replacement has no provenance");

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

      // ── #5454: the handle above is not enough; NAME the person ──────────
      //
      // The comment two blocks up used to end *"`provenance.actor` holds an
      // opaque id"*, and it was right about the payload and wrong about what
      // Atlas can do with it. #5440's census then measured the consequence: a
      // correction-minted claim rendered "cannot name this person" about the
      // most directly resolvable identifier in the system.
      //
      // ⚠️ This assertion is the one that would have caught it, and it runs
      // against a `brain_actor_identity` that is EMPTY — checked below, because
      // a name that arrived from a captured row would be testing a different
      // mechanism than the one that ships.
      const identities = await loadActorIdentities(identityReader, WS, [
        attribution.actor ?? "",
      ]);
      expect(identityFor(identities, attribution.actor)).toEqual({
        state: "atlas",
        userId: ACTOR_ID,
        name: "Ada Lovelace",
        email: ACTOR_EMAIL,
      });
      const { rows: identityRows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_actor_identity WHERE workspace_id = $1`,
        [WS],
      );
      expect(identityRows[0]?.n).toBe("0");

      // …and the LIVE half, which is what makes this the `atlas` state rather
      // than a snapshot wearing its name: rename the account, re-read, no
      // re-ingest and no capture pass in between.
      await pool.query(`UPDATE "user" SET name = 'Ada Byron' WHERE id = $1`, [ACTOR_ID]);
      const renamed = await loadActorIdentities(identityReader, WS, [attribution.actor ?? ""]);
      expect(identityFor(renamed, attribution.actor)).toMatchObject({ name: "Ada Byron" });
      await pool.query(`UPDATE "user" SET name = 'Ada Lovelace' WHERE id = $1`, [ACTOR_ID]);

      // AC3 — `provenance.actor` is byte-identical across the whole thing.
      // Compared as stored TEXT, not as a parsed object: an object compare
      // passes on a payload whose key order changed, and ADR-0037 §5's promise
      // is verbatim.
      const { rows: stored } = await pool.query<{ p: string }>(
        `SELECT provenance::text AS p FROM brain_facts WHERE id = $1::uuid`,
        [replacementId],
      );
      expect(stored[0]?.p).toBe(provenanceBefore);
      expect(JSON.parse(provenanceBefore).actor).toBe(`user:${ACTOR_ID}`);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§2c correction: the superseded row names who RETIRED it, through the supersedes edge",
    async () => {
      // The retitled #5454: a superseded claim records who authored it and not
      // who retired it, *"recoverable only by joining `admin_action_log` on
      // `target_id`"* — a per-org purgeable table whose workspace-purge scrub
      // replaces `target_id` with a sentinel.
      //
      // ⚠️ That "only" does not hold, and this is the instrument for it. The
      // retirement is recorded in `brain_edges` as `supersedes` (new → old),
      // and the SUCCESSOR's `provenance.actor` names the human who made it —
      // both in `brain_*` tables that travel on the region bundle and are not
      // the audit log. What was missing was never the record; it was the NAME,
      // and #5440's rendering is what made its absence say something false.
      //
      // So the retired row's question is answered by walking the edge the
      // correction already writes, and `history.ts` (#5461) is the read that
      // walks it for a person. This pins the two halves that make that walk
      // produce a name.
      const episodeId = await seedEpisode({
        workspaceId: WS,
        source: "slack",
        sourceId: "C-cond2/retire-target",
        sourceActor: "U-alice",
      });
      const { rows: seeded } = await pool.query<{ id: string }>(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance,
            status, visible_to, subject_key, predicate_key, object_key)
         VALUES ($1, 'Payroll', 'is owned by', 'Ana', $2, $3::jsonb, 'published', ARRAY['org'],
                 'payroll', 'is owned by', 'ana')
         RETURNING id::text AS id`,
        [
          WS,
          episodeId,
          JSON.stringify({
            source: "slack",
            sourceId: "C-cond2/retire-target",
            episodeId,
            actor: "slack:U-alice",
            producer: "extraction:v1",
            occurredAt: "2026-08-03T14:48:30.625Z",
          }),
        ],
      );
      const retiredId = seeded[0]?.id;
      if (retiredId === undefined) throw new Error("§2c: seed fact insert returned no id");

      await asRequest("req-cond2-retire", () =>
        correctFact(
          {
            vocabulary: identityVocabulary,
            ctx: reviewer(),
            factId: retiredId,
            verb: "supersede",
            reason: "Ana left",
            replacement: { object: "Bo" },
          },
          { withTransaction: poolTx },
        ),
      );

      // The retired row, and the two facts about it that are true TODAY: it is
      // closed, and its own actor is still its original author. Nothing on the
      // row says who retired it, and this test does not pretend otherwise.
      const retired = await attributionOf(WS, retiredId);
      expect(retired.actor).toBe("slack:U-alice");
      const { rows: closed } = await pool.query<{ valid_to: Date | null }>(
        `SELECT valid_to FROM brain_facts WHERE id = $1::uuid`,
        [retiredId],
      );
      expect(closed[0]?.valid_to).not.toBeNull();

      // The edge is the record, and it is in `brain_edges` — not the audit log.
      const { rows: successors } = await pool.query<{ from_fact_id: string }>(
        `SELECT from_fact_id::text AS from_fact_id
           FROM brain_edges
          WHERE workspace_id = $1 AND edge_type = 'supersedes' AND to_fact_id = $2::uuid`,
        [WS, retiredId],
      );
      expect(successors).toHaveLength(1);
      const successorId = successors[0]?.from_fact_id;
      if (successorId === undefined) throw new Error("§2c: supersedes edge returned no successor");

      // …and walking it produces a PERSON. This is the assertion that fails
      // without #5454: before it, the successor's `user:<id>` actor rendered
      // "cannot name this person", so the walk ended at a handle and condition
      // 5's *"see who changed it"* had no answer on the one lane built for it.
      const successor = await attributionOf(WS, successorId);
      expect(successor.actor).toBe(`user:${ACTOR_ID}`);
      const identities = await loadActorIdentities(identityReader, WS, [successor.actor ?? ""]);
      expect(identityFor(identities, successor.actor)).toMatchObject({
        state: "atlas",
        userId: ACTOR_ID,
        email: ACTOR_EMAIL,
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§2d a warehouse producer is a MACHINE, not an unnameable person",
    async () => {
      // #5440's Finding 2. `warehouse:system:warehouse-producer` has no
      // captured row, so it rendered `opaque` — a positive assertion that Atlas
      // looked for a person and could not name one. There is no person, and a
      // reader could not tell this from an author whose capture has not run.
      //
      // Against a real database because the claim is about what happens when
      // the TABLE HAS NOTHING TO SAY: an in-memory double asserting an empty
      // fixture proves only that the fixture was empty.
      // ⚠️ The BARE principal. `warehouse-producer.ts` stamps this verbatim;
      // nothing composes a `warehouse:` prefix onto it. This test asserted the
      // composed form and so proved nothing about production rows -- the input
      // was a literal the author assumed, which is the "asserts its own script"
      // failure this file warns about elsewhere.
      const actor = WAREHOUSE_PRODUCER_PRINCIPAL;
      const identities = await loadActorIdentities(identityReader, WS, [actor, "slack:U-nobody"]);
      expect(identityFor(identities, actor)).toEqual({ state: "machine" });
      // The control, in the same call: an ordinary handle with no row is still
      // `opaque`, so the new arm is a DISTINCTION and not a blanket rewrite of
      // what an absent row means.
      expect(identityFor(identities, "slack:U-nobody")).toEqual({
        state: "opaque",
        erased: false,
      });
      // Nothing was written to reach either answer.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_actor_identity WHERE workspace_id = $1`,
        [WS],
      );
      expect(rows[0]?.n).toBe("0");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§2b correction: a re-authority stamps the vouching person ONTO the claim",
    async () => {
      const episodeId = await seedEpisode({
        workspaceId: WS,
        source: "slack",
        sourceId: "C-cond2/vouch-target",
        sourceActor: "U-alice",
      });
      const originalProvenance = {
        source: "slack",
        sourceId: "C-cond2/vouch-target",
        episodeId,
        actor: "slack:U-alice",
        producer: "extraction:v1",
        occurredAt: "2026-08-03T14:48:30.625Z",
      };
      const { rows: seeded } = await pool.query<{ id: string }>(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance,
            status, visible_to, subject_key, predicate_key, object_key)
         VALUES ($1, 'Deploys', 'happen on', 'Thursdays', $2, $3::jsonb, 'published', ARRAY['org'],
                 'deploys', 'happen on', 'thursdays')
         RETURNING id::text AS id`,
        [WS, episodeId, JSON.stringify(originalProvenance)],
      );
      const factId = seeded[0]?.id;
      if (factId === undefined) throw new Error("§2b: seed fact insert returned no id");

      const outcome = await asRequest("req-cond2-vouch", () =>
        correctFact(
          {
            vocabulary: identityVocabulary,
            ctx: reviewer(),
            factId,
            verb: "re-authority",
            reason: "confirmed with the release owner",
          },
          { withTransaction: poolTx },
        ),
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

      const { rows } = await pool.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM brain_facts WHERE workspace_id = $1 AND id = $2::uuid`,
        [WS, factId],
      );
      const provenance = rows[0]?.provenance;
      if (provenance === undefined) throw new Error("§2b: no fact row after the vouch");

      // The ONLY verb in the product that writes a person's name onto an
      // EXISTING claim's own `provenance`. `supersede` mints a new row and
      // attributes that; `retract` writes nothing to the payload at all
      // (`RETRACT_FACT_SQL` sets `invalidated_at` and `updated_at`, nothing
      // else), which is why prod's four retractions are attributable only
      // through the correction episode and the audit row.
      const marker = provenance.reAuthority as Record<string, unknown> | undefined;
      if (marker === undefined) throw new Error("§2b: no reAuthority marker on the provenance");
      // The BARE Atlas user id, not the `user:<id>` principal `supersede`
      // writes — `applyVouch` takes `ctx.userId` directly while the replacement
      // claim takes the grammar-valid principal. Two spellings of one person,
      // and a reader of the record has to know that.
      expect(marker.actor).toBe(ACTOR_ID);
      expect(marker.correctionEpisodeId).toBe(outcome.result.correctionEpisodeId);
      expect(typeof marker.at).toBe("string");
      expect(new Date(marker.at as string).toString()).not.toBe("Invalid Date");

      // The merge is `provenance || $3::jsonb`, so it can only ADD. Asserted
      // rather than assumed: a marker write that clobbered the original
      // attribution would replace one person's name with another's and still
      // look like a claim with a name on it.
      for (const [key, value] of Object.entries(originalProvenance)) {
        expect(provenance[key]).toBe(value);
      }
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
    /** The bundle's own review status. Defaults to the interesting one. */
    status?: "draft" | "published" | "archived";
  }): ExportBundle {
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
              status: opts.status ?? "published",
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

  async function runImport(bundle: ExportBundle, orgId: string): Promise<void> {
    // Through the REAL validator, never bypassed — `validateBundle` is where a
    // refusal would live, so a fixture that skipped it would prove nothing
    // about what the route accepts. §3b asserts its verdict separately for
    // exactly that reason.
    const validation = validateBundle(bundle);
    if (!validation.ok) throw new Error(`bundle rejected: ${validation.error}`);
    await withTx((client) => importBundle(client, validation.bundle, orgId));
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
    "§3b migration: a bundle carrying NO attribution lands as a DRAFT, not published",
    async () => {
      const episodeId = "c2000000-0000-4000-8000-00000000a002";
      const factId = "c2000000-0000-4000-8000-00000000f002";

      // Non-empty, so it clears `chk_brain_facts_provenance_nonempty` and the
      // validator's `Object.keys(...).length > 0`. Attribution-free, so it
      // names nobody — which is the whole test.
      const bundle = bundleWith({
        episodeId,
        factId,
        sourceActor: null,
        provenance: { note: "restored from an archive; original actor unknown" },
        status: "published",
      });

      // ⚠️ THE BUNDLE IS STILL ACCEPTED, and this assertion is half the fix.
      // Refusing was the obvious alternative and `lib/brain/sources.ts` rejects
      // it for `source` on reasoning that transfers unchanged: validation is
      // all-or-nothing, so one unattributed fact from a corpus predating the
      // reconcile gate would strand the entire workspace in its source region,
      // discovered at cutover. A future tightening that moved the check into
      // `validateBundle` fails HERE rather than in a live migration.
      const validation = validateBundle(bundle);
      expect(validation.ok).toBe(true);

      await runImport(bundle, IMPORT_WS);

      const attribution = await attributionOf(IMPORT_WS, factId);
      // The fix (#5424). The bundle said `published`; it lands `draft`, because
      // an authoritative claim must have a human name on it and this one has
      // none. `status` is the ONLY column the region import does not restore
      // verbatim.
      expect(attribution.status).toBe("draft");
      // Still unattributed — the import does not INVENT a name, which would be
      // the worse fix. It declines to confer authority, and that is all.
      expect(attribution.actor).toBeNull();
      expect(attribution.episode_source_actor).toBeNull();

      // Nothing else moved. A demotion that also dropped the claim, its
      // surfaces or its evidence pointer would be a data-loss bug wearing a
      // fix's clothes.
      expect(attribution.episode_source).toBe("slack");
      const { rows } = await pool.query<{ subject: string; object: string }>(
        `SELECT subject, object FROM brain_facts WHERE workspace_id = $1 AND id = $2::uuid`,
        [IMPORT_WS, factId],
      );
      expect(rows[0]?.subject).toBe("Imported claim");
      expect(rows[0]?.object).toBe("yes");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§3c migration: an unattributed DRAFT is left alone — the fix touches authority only",
    async () => {
      const episodeId = "c2000000-0000-4000-8000-00000000a003";
      const factId = "c2000000-0000-4000-8000-00000000f003";
      await runImport(
        bundleWith({
          episodeId,
          factId,
          sourceActor: null,
          provenance: { note: "no actor, and the bundle already said draft" },
          status: "draft",
        }),
        IMPORT_WS,
      );

      // The demotion is conditioned on the bundle's own `status`. Without this
      // case, a fix that demoted EVERY unattributed row would look identical to
      // one that only declines to publish — and the first would be a silent
      // rewrite of review decisions the source region legitimately made.
      const attribution = await attributionOf(IMPORT_WS, factId);
      expect(attribution.status).toBe("draft");
      expect(attribution.actor).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "§3d migration: a blank-string actor is treated as no name at all",
    async () => {
      const episodeId = "c2000000-0000-4000-8000-00000000a004";
      const factId = "c2000000-0000-4000-8000-00000000f004";
      await runImport(
        bundleWith({
          episodeId,
          factId,
          sourceActor: null,
          // Whitespace, not absence. It passes every bare truthiness check and
          // names nobody — the same trap `brainEnrollments[].enrolledBy` trims
          // for, one section over in the same validator.
          provenance: { source: "slack", actor: "   " },
          status: "published",
        }),
        IMPORT_WS,
      );

      const attribution = await attributionOf(IMPORT_WS, factId);
      expect(attribution.status).toBe("draft");
    },
    PG_TEST_TIMEOUT_MS,
  );
});
