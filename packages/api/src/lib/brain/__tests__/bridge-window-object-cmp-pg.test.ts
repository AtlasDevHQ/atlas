/**
 * #5233 part 2 — can a bridge-window `object_cmp` reach a `valid_to` stamp?
 *
 * The question #5043 recorded rather than answered. Region-imported store
 * entries carry ids minted over the SOURCE workspace. Extraction consults the
 * store, so a fact written during the bridge window (before the destination's
 * first producer run) carries a source-workspace id; that run then mints a
 * fresh id, and a later local fact about the SAME entity carries the new one.
 *
 * Both non-null, both `entity:`-tagged, unequal — which is the *provably
 * different* arm, the one that feeds `supersessionCollisionJoin`.
 *
 * The scenario below isolates exactly that and nothing else: same subject,
 * same predicate, SAME OBJECT SURFACE. The two rows differ only in the entity
 * id their comparable carries. If publish stamps `valid_to`, a fact was
 * retired by a fact making the identical claim, purely because the store
 * re-minted an id.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import { declarePredicateCardinality } from "@atlas/api/lib/brain/cardinality";
import { comparableValue } from "@atlas/api/lib/brain/object-cmp";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("#5233 bridge-window object_cmp (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_bridge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedEpisode(workspaceId: string, sourceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', $2, 'evidence', $3::text[]) RETURNING id`,
      [workspaceId, sourceId, ["org"]],
    );
    return rows[0]!.id;
  }

  /** A fact whose object comparable carries a caller-chosen entity id. */
  async function seedFact(opts: {
    workspaceId: string;
    episodeId: string;
    subject: string;
    object: string;
    entityId: string;
    status?: "draft" | "published";
    provenance?: Record<string, unknown>;
  }): Promise<string> {
    const predicate = "works_at";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id,
          provenance, status, visible_to,
          subject_key, predicate_key, object_key, object_cmp)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11, $12)
       RETURNING id`,
      [
        opts.workspaceId,
        opts.subject,
        predicate,
        opts.object,
        opts.episodeId,
        JSON.stringify(opts.provenance ?? { actor: "test" }),
        opts.status ?? "draft",
        ["org"],
        slotKey(opts.subject, identityAlias),
        slotKey(predicate, identityAlias),
        slotKey(opts.object, identityAlias),
        comparableValue({ surface: opts.object, entityId: opts.entityId }),
      ],
    );
    const declared = await declarePredicateCardinality(pool, opts.workspaceId, {
      predicateKey: slotKey(predicate, identityAlias),
      cardinality: "single",
      authoredBy: "curator-1",
    });
    expect(declared.ok, "cardinality declaration failed — supersession would never fire").toBe(true);
    return rows[0]!.id;
  }

  async function publish(workspaceId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, workspaceId));
      await client.query("COMMIT");
      return report;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function factState(id: string) {
    const { rows } = await pool.query<{ status: string; valid_to: Date | null }>(
      `SELECT status, valid_to FROM brain_facts WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  // ⚠️ SKIPPED, and deliberately not inverted into a characterization test.
  // This asserts the behaviour the remedy must DELIVER; it fails today, which is
  // the answer to #5233's AC-4. Inverting it would pin the hazard as correct —
  // the shape this codebase refuses elsewhere ("an unexercised guard reported as
  // working"). Un-skip when the remedy lands. Run it now to see the stamp.
  it.skip(
    "an id re-mint alone must not retire a fact making the identical claim",
    async () => {
      const ws = "ws-5233-bridge";
      const ep = await seedEpisode(ws, "bridge");

      // Written during the bridge window: the store it consulted was imported,
      // so the id is minted over the SOURCE workspace.
      const bridge = await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "alice",
        object: "Acme Corp",
        entityId: "wh_SOURCE_workspace_minted_id",
        status: "published",
      });

      // Written after the destination's first producer run re-minted the id.
      // Same subject, same predicate, SAME OBJECT SURFACE — only the id moved.
      const afterRun = await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "alice",
        object: "Acme Corp",
        entityId: "wh_DESTINATION_freshly_minted_id",
      });


      const report = await publish(ws);
      const bridgeState = await factState(bridge);


      expect(
        bridgeState.valid_to,
        "a bridge-window fact was retired by a fact asserting the SAME object surface — the id re-mint alone drove the stamp",
      ).toBeNull();
      expect(afterRun).toBeTruthy();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "CONTROL — the same two facts with the SAME entity id do not supersede",
    async () => {
      const ws = "ws-5233-control-same-id";
      const ep = await seedEpisode(ws, "control");
      const first = await seedFact({
        workspaceId: ws, episodeId: ep, subject: "alice", object: "Acme Corp",
        entityId: "wh_ONE_stable_id", status: "published",
      });
      await seedFact({
        workspaceId: ws, episodeId: ep, subject: "alice", object: "Acme Corp",
        entityId: "wh_ONE_stable_id",
      });
      const report = await publish(ws);
      const state = await factState(first);
      expect(state.valid_to).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ⚠️ SKIPPED for the same reason — see above. Proves the hazard is NOT an
  // artefact of the source-less tier carve-out: it fires on a real extraction
  // provenance too.
  it.skip(
    "FIDELITY — it still stamps with a real extraction provenance (source: slack), not only the no-source carve-out",
    async () => {
      const ws = "ws-5233-slack";
      const ep = await seedEpisode(ws, "slack-prov");
      const prov = { actor: "slack:U1", source: "slack", producer: "extraction:v1" };
      const bridge = await seedFact({
        workspaceId: ws, episodeId: ep, subject: "alice", object: "Acme Corp",
        entityId: "wh_SOURCE_id", status: "published", provenance: prov,
      });
      await seedFact({
        workspaceId: ws, episodeId: ep, subject: "alice", object: "Acme Corp",
        entityId: "wh_DEST_id", provenance: prov,
      });
      const report = await publish(ws);
      const state = await factState(bridge);
      expect(
        state.valid_to,
        "with a realistic slack provenance the stamp still fires — the repro is not exploiting the source-less carve-out",
      ).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );
});
