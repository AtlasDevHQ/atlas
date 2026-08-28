/**
 * **The suggester's drafts against the real gate** (#5488, ADR-0036 §T9
 * lock 1) — the BEHAVIORAL half of two acceptance criteria the unit lane can
 * only pin structurally:
 *
 *   1. **Draft-only.** *"A test fails if any suggester-produced candidate can
 *      reach `published` without passing #5483's gate."* Here a real tick
 *      files a real row: it must land `status = 'draft'`, sit there
 *      unpublished, and move to `published` only when the real gate
 *      (`promoteBrainFacts`, the `/api/v1/admin/publish` transaction) runs.
 *   2. **Disabling stops production and deletes nothing.** The dial flips off
 *      between ticks; the second tick must file nothing new AND the first
 *      tick's draft must still be on the queue, untouched.
 *
 * Plus the properties that make those two meaningful: the filed draft is
 * reviewable through `loadFactCandidates` carrying the
 * `BRAIN_SUGGESTER_PRODUCER` origin discriminator, its grant is the
 * conversation OWNER's token (lock 3's narrowest defensible audience — never
 * a silent `[org]`), its session episode is by-reference with `extracted_at`
 * stamped (off the extraction fiber's queue), and a re-enabled second pass
 * over the same conversation files nothing twice (the episode IS the durable
 * watermark).
 *
 * ## Why `-pg` and not the unit lane
 *
 * `suggester.test.ts` proves what the module SENDS across the reconcile seam;
 * every claim above is about what Postgres HOLDS after the transaction
 * committed — the 0180 `DEFAULT 'draft'`, the dedupe key's `NOT EXISTS`, the
 * ACL predicate behind the reviewer's queue, and the publish stamp are all
 * evaluated by the database, which a fake executor cannot see.
 *
 * The tick runs END-TO-END real (enumeration → conversation scan → transcript
 * → episode mint → reconcile) with exactly two injected seams: `extract`
 * (canned candidates — the model call is the one collaborator a test may not
 * spend) and `resolveModel` (its stub). `organization` is a Better-Auth table
 * whose migrations the harness skips (`MANAGED_AUTH_MIGRATIONS`), so the
 * schema carries a minimal stub of it — id-only, which is all the enumeration
 * reads.
 *
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { BRAIN_SUGGESTER_PRODUCER } from "@useatlas/schemas";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import { _resetConfig, _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";
import { _resetSettingsCache } from "@atlas/api/lib/settings";
import {
  _resetSuggesterLedger,
  runSuggesterTick,
  type SuggesterDeps,
} from "@atlas/api/lib/brain/suggester";
import type { FactCandidate } from "@atlas/api/lib/brain/reconcile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "org-suggester-pg";
const OWNER = "U-owner";
const CONVERSATION_ID = "1af9a1f0-5488-4000-8000-0000000054aa";

/** The canned claim the injected extractor "finds" in the transcript. */
const CLAIM: FactCandidate = {
  subject: "Ana",
  predicate: "is the DRI for",
  object: "billing",
};

const SELF_HOSTED: ResolvedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "managed",
  semanticLayer: "./semantic",
  maxTotalConnections: 100,
  source: "file",
  deployMode: "self-hosted",
};

describeIfPg("the suggester's drafts against the real gate (#5488)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5488_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Injected seams: the model call and its resolution. Everything else real. */
  let extractCalls = 0;
  let cannedCandidates: readonly FactCandidate[] = [CLAIM];
  const deps: SuggesterDeps = {
    resolveModel: async () => ({
      model: { specificationVersion: "v2" } as never,
      modelId: "test-model",
      batchApiKey: null,
    }),
    extract: async () => {
      extractCalls++;
      return cannedCandidates;
    },
  };

  beforeAll(async () => {
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
    // Better Auth owns the real `organization` table and its migrations are
    // skipped above; the enumeration reads only `id`, so an id-only stub
    // keeps the tick end-to-end real without dragging the auth stack in.
    await pool.query(`CREATE TABLE IF NOT EXISTS organization (id text PRIMARY KEY)`);
    await pool.query(`INSERT INTO organization (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      WORKSPACE,
    ]);
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    delete process.env.ATLAS_BRAIN_SUGGESTER_ENABLED;
    _resetSettingsCache();
    _resetConfig();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    delete process.env.ATLAS_BRAIN_SUGGESTER_ENABLED;
    _resetSettingsCache();
    _resetConfig();
    _resetSuggesterLedger();
    extractCalls = 0;
    cannedCandidates = [CLAIM];
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM messages");
    await pool.query("DELETE FROM conversations");
  });

  function enable(): void {
    process.env.ATLAS_BRAIN_SUGGESTER_ENABLED = "true";
    _resetSettingsCache();
    _setConfigForTest(SELF_HOSTED);
  }

  function disable(): void {
    delete process.env.ATLAS_BRAIN_SUGGESTER_ENABLED;
    _resetSettingsCache();
    _setConfigForTest(SELF_HOSTED);
  }

  /** An idle, owned, transcript-bearing conversation for the tick to find. */
  async function seedConversation(id = CONVERSATION_ID): Promise<void> {
    await pool.query(
      `INSERT INTO conversations (id, user_id, org_id, updated_at)
       VALUES ($1::uuid, $2, $3, now() - interval '2 hours')`,
      [id, OWNER, WORKSPACE],
    );
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1::uuid, 'user', $2::jsonb), ($1::uuid, 'assistant', $3::jsonb)`,
      [
        id,
        JSON.stringify({
          parts: [
            {
              type: "text",
              text: `Ana is the DRI for billing — took over last sprint. ${"context ".repeat(40)}`,
            },
          ],
        }),
        JSON.stringify({ parts: [{ type: "text", text: "Noted: Ana owns billing." }] }),
      ],
    );
  }

  /**
   * The reviewer is the conversation OWNER wearing the admin hat, and that is
   * a statement about the grant, not a convenience: a suggested draft's seed
   * is `[user:<owner>]` (lock 3's narrowest defensible audience, the same
   * seed #5486 gives a session-carrying human proposal), and the admin queue
   * is reader-scoped with the audit override deliberately unwired
   * (`admin-brain-facts.ts`) — so until the widening flow moves the grant,
   * the reviewer who can see this draft is one holding the owner's token.
   * Inherited from the #5486 seed decision, not introduced here.
   */
  const reviewer: BrainPrincipalContext = {
    origin: "authenticated",
    workspaceId: WORKSPACE,
    userId: OWNER,
    role: "admin",
    audienceIds: [],
  };

  async function factRows() {
    const { rows } = await pool.query<{
      id: string;
      status: string;
      visible_to: string[];
      invalidated_at: Date | null;
    }>(
      `SELECT id, status, visible_to, invalidated_at
         FROM brain_facts WHERE workspace_id = $1 ORDER BY created_at`,
      [WORKSPACE],
    );
    return rows;
  }

  it(
    "⭐ a suggested candidate lands as a DRAFT and reaches published ONLY through the #5483 gate",
    async () => {
      enable();
      await seedConversation();

      const result = await runSuggesterTick(deps);
      expect(result.drafted).toBe(1);
      expect(result.errors).toBe(0);

      // What Postgres holds: one fact, draft by 0180's DEFAULT (nothing in
      // the suggester's path names `status`), granted to the OWNER alone —
      // lock 3's narrowest defensible audience, never a silent [org].
      const beforePublish = await factRows();
      expect(beforePublish).toHaveLength(1);
      expect(beforePublish[0]!.status).toBe("draft");
      expect(beforePublish[0]!.visible_to).toEqual([`user:${OWNER}`]);

      // The session episode is by-reference (body NULL, locator bound) and
      // stamped extracted_at, so the extraction fiber can never re-derive
      // the machine's own suggestion as a second machine claim.
      const { rows: episodes } = await pool.query<{
        body: string | null;
        locator: string | null;
        extracted_at: Date | null;
      }>(`SELECT body, locator, extracted_at FROM brain_episodes WHERE workspace_id = $1`, [
        WORKSPACE,
      ]);
      expect(episodes).toHaveLength(1);
      expect(episodes[0]!.body).toBeNull();
      expect(episodes[0]!.locator).toBe(`conversation:${CONVERSATION_ID}`);
      expect(episodes[0]!.extracted_at).not.toBeNull();

      // Reviewable, and labelled as the machine's: the queue row carries the
      // producer discriminator the origin badge branches on — a reviewer can
      // tell this guess from a person's testimony (acceptance criterion 4).
      const queue = await loadFactCandidates(pool, {
        ctx: reviewer,
        status: "draft",
        limit: 10,
        offset: 0,
      });
      expect(queue.candidates).toHaveLength(1);
      expect(queue.candidates[0]!.provenance.producer).toBe(BRAIN_SUGGESTER_PRODUCER);

      // The gate is the ONLY exit from draft: running the real publish
      // transaction promotes it, exactly as it promotes any other draft.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await Effect.runPromise(promoteBrainFacts(client, WORKSPACE));
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      const afterPublish = await factRows();
      expect(afterPublish[0]!.status).toBe("published");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "⭐ disabling stops production of NEW suggestions and does not touch drafts already raised",
    async () => {
      enable();
      await seedConversation();
      const first = await runSuggesterTick(deps);
      expect(first.drafted).toBe(1);

      // The dial flips off; a fresh, unharvested conversation appears.
      disable();
      await seedConversation("2bf9a1f0-5488-4000-8000-0000000054bb");
      const second = await runSuggesterTick(deps);

      // No workspace considered, no model spent, nothing filed…
      expect(second.workspacesConsidered).toBe(0);
      expect(second.drafted).toBe(0);
      expect(extractCalls).toBe(1);

      // …and the draft the first tick raised is exactly where it was: still
      // a draft, still on the queue, not tombstoned, not deleted.
      const rows = await factRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("draft");
      expect(rows[0]!.invalidated_at).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a harvested conversation is never harvested twice — the episode is the durable watermark",
    async () => {
      enable();
      await seedConversation();
      const first = await runSuggesterTick(deps);
      expect(first.drafted).toBe(1);
      expect(extractCalls).toBe(1);

      // Same workspace, same conversation, fresh tick (ledger cleared to
      // prove the DURABLE mark carries this, not the in-memory one).
      _resetSuggesterLedger();
      const second = await runSuggesterTick(deps);
      expect(second.conversationsScanned).toBe(0);
      expect(extractCalls).toBe(1);
      expect(await factRows()).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a no-find conversation materializes NOTHING — no episode, no fact (lock 3's lazy property)",
    async () => {
      enable();
      await seedConversation();
      cannedCandidates = [];
      const result = await runSuggesterTick(deps);
      expect(result.conversationsScanned).toBe(1);
      expect(result.drafted).toBe(0);
      const { rows } = await pool.query(`SELECT 1 FROM brain_episodes WHERE workspace_id = $1`, [
        WORKSPACE,
      ]);
      expect(rows).toHaveLength(0);
      expect(await factRows()).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
