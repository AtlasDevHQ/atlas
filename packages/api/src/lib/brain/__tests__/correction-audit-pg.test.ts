/**
 * The correction's `admin_action_log` row against LIVE Postgres (#4934).
 *
 * `correction-audit.test.ts` pins the row the machinery ASKS for, against a
 * mocked `lib/audit`. That is the wrong instrument for three claims, all of
 * which this file owns:
 *
 *   1. **The resolved row.** `logAdminActionAwait` → `resolveEntry` derives
 *      `actor_id`, `actor_email`, `org_id` and `request_id` from the
 *      AsyncLocalStorage request context, and the mocked suite stubs that away.
 *      #4934's whole point is that a chat-initiated correction lands an
 *      ATTRIBUTED forensic row; a test that never resolves the actor cannot
 *      say whether it does.
 *   2. **That the INSERT lands at all.** The write's failure is swallowed at
 *      ERROR by design (a committed correction must not be reported as
 *      failed), so a broken column, a renamed table, or a CHECK the metadata
 *      violates would leave every other gate in the repo green. The swallow is
 *      correct; it just means nothing above this file can notice.
 *   3. **`supersede`'s `supersededBy` / `validTo` metadata.** Those two keys
 *      are conditional spreads no other verb can produce — every fixture in
 *      the mocked suite leaves them null, so only the OMISSION branch is
 *      exercised there. They are also the keys an auditor pivots on to answer
 *      "what replaced this belief", and driving `supersede` needs the whole
 *      reconcile path, which is exactly what a live schema gives for free.
 *
 * Its own bootstrap rather than a ride on `candidates-pg.test.ts` §7 for one
 * reason: this file must set `DATABASE_URL` and `_resetPool` the internal pool
 * so `hasInternalDB()` is true and `internalQuery` reaches the test schema.
 * That is a file-global change of posture — every correction in the suite then
 * writes a real audit row — and imposing it on a suite written against the
 * `hasInternalDB() === false` short-circuit would change what those 20 tests
 * mean without changing a line of them.
 *
 * One limit worth knowing: `_resetPool` nulls the `@effect/sql` client too, so
 * `internalQuery` here takes its raw-pool branch. This proves the row lands and
 * what it contains; it does not exercise the `PgClient` path production uses
 * once the InternalDB Layer has booted.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { identityAlias, identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { withRequestContext } from "@atlas/api/lib/logger";
import { CORRECTION_REFUSAL_REASONS, correctFact } from "@atlas/api/lib/brain/correction";
import type { ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-correction-audit-pg";
const ACTOR_ID = "user-admin-1";
const ACTOR_EMAIL = "admin@example.test";

function reviewer(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: ACTOR_ID,
    role: "admin",
    audienceIds: [],
  };
}

interface AuditRow {
  readonly action_type: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly actor_id: string;
  readonly actor_email: string;
  readonly org_id: string | null;
  readonly request_id: string;
  readonly scope: string;
  readonly status: string;
  readonly metadata: Record<string, unknown> | null;
}

describeIfPg("correction audit row (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_corr_audit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `hasInternalDB()` reads `DATABASE_URL`, not the pool — without this the
    // audit write takes its "no internal database" early return and this whole
    // file asserts nothing. Set inside the hook per the test-discipline rule;
    // restored in `afterAll`. `search_path` is baked into the connection
    // string, not SET from an unawaited `pool.on("connect")` handler.
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
    // `internalQuery` — which is the only path `logAdminActionAwait` takes —
    // resolves the module-level internal pool, so it has to BE this
    // schema-scoped pool or the rows land in `public`.
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
   * One transaction on the test pool, handed to `correctFact` through
   * `deps.withTransaction`.
   *
   * Deliberately the same shape as production's `withBrainTransaction`, down to
   * the `.catch` on the ROLLBACK and the `client.release(rollbackErr)`. A naive
   * `await client.query("ROLLBACK"); throw err;` would let a rollback-time
   * failure REPLACE the original cause — which in the refusal test below would
   * swap the `CorrectionRefusedError` for a pg error and fail the assertion
   * naming the wrong thing — and an unconditional `release()` would hand a
   * client still inside an aborted transaction back to the pool, where
   * `auditRowsFor`'s next query fails with "current transaction is aborted".
   */
  const poolTx: ReconcileTransactionRunner = async <T,>(
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }> }) => Promise<T>,
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
        // Logged, not just captured: without this a failed ROLLBACK is
        // invisible and the fixture's real problem is a destroyed connection
        // with no stated reason.
        console.warn(`correction-audit-pg: ROLLBACK failed — ${rollbackErr.message}`);
      });
      throw err;
    } finally {
      client.release(rollbackErr);
    }
  };

  async function seedPublishedFact(opts: {
    subject: string;
    predicate: string;
    object: string;
    sourceId: string;
  }): Promise<string> {
    const { rows: episodes } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U1', 'evidence', now(), ARRAY['org'])
       RETURNING id`,
      [WS, opts.sourceId],
    );
    const episodeId = episodes[0]?.id;
    if (episodeId === undefined) throw new Error("seed: episode insert returned no id");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          status, visible_to, predicate_cardinality,
          subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'published', ARRAY['org'], 'single',
               $7, $8, $9)
       RETURNING id`,
      [
        WS,
        opts.subject,
        opts.predicate,
        opts.object,
        episodeId,
        JSON.stringify({ source: "slack", actor: "U1" }),
        // Keyed like an ingested row (#5020). These tests assert audit-row
        // SHAPE, so they pass either way today — but `correct_fact`'s supersede
        // verb runs the pivoted corroboration and tension lookups, and an
        // unkeyed seed is a corpus state the ingest path cannot produce. The
        // next assertion anyone adds here about corroboration or tension edges
        // would be silently vacuous against it.
        slotKey(opts.subject, identityAlias),
        slotKey(opts.predicate, identityAlias),
        slotKey(opts.object, identityAlias),
      ],
    );
    const factId = rows[0]?.id;
    if (factId === undefined) throw new Error("seed: fact insert returned no id");
    return factId;
  }

  async function auditRowsFor(targetId: string): Promise<AuditRow[]> {
    const { rows } = await pool.query<AuditRow>(
      `SELECT action_type, target_type, target_id, actor_id, actor_email, org_id,
              request_id, scope, status, metadata
         FROM admin_action_log
        WHERE target_id = $1
     ORDER BY timestamp`,
      [targetId],
    );
    return rows;
  }

  /**
   * Both entry points run the correction inside a request context — the HTTP
   * routes through `createAdminRouter`'s middleware, the agent tool through the
   * chat route's `withRequestContext`. Modelling that here is the point: it is
   * what turns the row from "an event happened" into "this admin, in this org,
   * on this request".
   */
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

  it(
    "a retract lands an ATTRIBUTED brain_fact.retract row in admin_action_log",
    async () => {
      const factId = await seedPublishedFact({
        subject: "Deploys",
        predicate: "happen on",
        object: "Thursdays",
        sourceId: "audit-pg-retract",
      });

      const outcome = await asRequest("req-retract-1", () =>
        correctFact(
          { vocabulary: identityVocabulary, ctx: reviewer(), factId, verb: "retract", reason: "wrong on arrival" },
          { withTransaction: poolTx },
        ),
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

      const rows = await auditRowsFor(factId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      // Named throw rather than `rows[0]?.x`: an optional-chained assertion
      // against a missing row compares `undefined` to `undefined` and passes.
      if (row === undefined) throw new Error("no admin_action_log row for the retract");

      expect(row.action_type).toBe("brain_fact.retract");
      expect(row.target_type).toBe("brainFact");
      expect(row.target_id).toBe(factId);
      expect(row.status).toBe("success");
      expect(row.scope).toBe("workspace");
      // The half `correction-audit.test.ts` structurally cannot see: every one
      // of these comes from `resolveEntry` reading the request context, and a
      // row that exists but says `actor_id = 'unknown'` is a worse artifact
      // than the missing row #4934 fixed.
      expect(row.actor_id).toBe(ACTOR_ID);
      expect(row.actor_email).toBe(ACTOR_EMAIL);
      expect(row.org_id).toBe(WS);
      expect(row.request_id).toBe("req-retract-1");

      expect(row.metadata).toMatchObject({
        verb: "retract",
        workspaceId: WS,
        correctionEpisodeId: outcome.result.correctionEpisodeId,
        invalidatedAt: outcome.result.invalidatedAt,
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a supersede records WHAT replaced the belief and when the window closed",
    async () => {
      const factId = await seedPublishedFact({
        subject: "Billing",
        predicate: "is owned by",
        object: "Ana",
        sourceId: "audit-pg-supersede",
      });

      const outcome = await asRequest("req-supersede-1", () =>
        correctFact(
          {
            vocabulary: identityVocabulary,
            ctx: reviewer(),
            factId,
            verb: "supersede",
            reason: "Ana left; Bo took over",
            replacement: { object: "Bo" },
          },
          { withTransaction: poolTx },
        ),
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);
      expect(outcome.result.supersededBy).toBeTruthy();
      expect(outcome.result.validTo).toBeTruthy();

      const rows = await auditRowsFor(factId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("no admin_action_log row for the supersede");

      // The non-retract verbs share ONE action type, so `metadata.verb` is the
      // only thing distinguishing a supersession from a pin in the trail.
      expect(row.action_type).toBe("brain_fact.correct");
      expect(row.actor_id).toBe(ACTOR_ID);
      expect(row.request_id).toBe("req-supersede-1");
      // The two conditional keys no other verb can produce, and the reason this
      // file drives `supersede` at all: without them the row records that a
      // belief was retired and not what replaced it.
      expect(row.metadata).toMatchObject({
        verb: "supersede",
        workspaceId: WS,
        correctionEpisodeId: outcome.result.correctionEpisodeId,
        supersededBy: outcome.result.supersededBy,
        validTo: outcome.result.validTo,
      });
      // …and a supersession is not a tombstone, so the retract-only key stays
      // off. `toMatchObject` above would happily ignore an extra `invalidatedAt`.
      expect(row.metadata).not.toHaveProperty("invalidatedAt");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a pin records the verb and nothing it did not decide, under the CANONICAL fact id",
    async () => {
      const factId = await seedPublishedFact({
        subject: "Oncall",
        predicate: "rotates",
        object: "weekly",
        sourceId: "audit-pg-pin",
      });

      // Upper-cased on the way in, and that is the point. Postgres canonicalizes
      // on the `::uuid` cast so the correction succeeds either way, but the
      // agent tool takes `factId` as a bare `z.string()` with no normalization —
      // so an LLM echoing a differently-cased id would, if the row used the
      // CALLER's string, produce a `target_id` that does not string-join to
      // `brain_facts.id`. The emitter uses `result.factId` for exactly this.
      const outcome = await asRequest("req-pin-1", () =>
        correctFact(
          { vocabulary: identityVocabulary, ctx: reviewer(), factId: factId.toUpperCase(), verb: "pin" },
          { withTransaction: poolTx },
        ),
      );
      if (outcome.kind !== "corrected") throw new Error(`expected corrected, got ${outcome.kind}`);

      const rows = await auditRowsFor(factId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("no admin_action_log row for the pin");
      expect(row.action_type).toBe("brain_fact.correct");
      // Lower-case, i.e. the DB's spelling — not the upper-cased string the
      // caller passed. `auditRowsFor` queried on the canonical id and found it,
      // which is the join this pins.
      expect(row.target_id).toBe(factId);
      // Exactly the three unconditional keys FROM THIS CALL SITE — a `pin`
      // neither tombstones, supersedes, nor closes a validity window, and a row
      // asserting `invalidatedAt: null` reads as a decision that was made.
      // (`resolveEntry` also merges `trustDeviceIdentifier` / `origin` when the
      // context carries them; this context carries neither, so a strict
      // `toEqual` is right and forces a deliberate decision if that changes.)
      expect(row.metadata).toEqual({
        verb: "pin",
        workspaceId: WS,
        correctionEpisodeId: outcome.result.correctionEpisodeId,
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a REFUSED correction writes no row — the rollback takes the audit with it",
    async () => {
      const factId = await seedPublishedFact({
        subject: "Revenue",
        predicate: "was",
        object: "$1M",
        sourceId: "audit-pg-refused",
      });
      // Tier-1: refused from INSIDE the transaction, through the rollback
      // catch — the return path a test that only exercises the pre-transaction
      // authority refusal never reaches.
      await pool.query(
        `UPDATE brain_facts SET provenance = jsonb_set(provenance, '{source}', '"warehouse"') WHERE id = $1`,
        [factId],
      );

      const outcome = await asRequest("req-refused-1", () =>
        correctFact({ vocabulary: identityVocabulary, ctx: reviewer(), factId, verb: "pin" }, { withTransaction: poolTx }),
      );
      expect(outcome).toMatchObject({
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.warehouseTarget,
      });
      expect(await auditRowsFor(factId)).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
