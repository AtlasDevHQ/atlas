/**
 * Real-Postgres tests for the durable per-session working-memory SQL (#3754,
 * ADR-0020, slice 1).
 *
 * The upsert's `ON CONFLICT` on the composite PK, the `org_id` COALESCE, the
 * `$4::jsonb` cast + JSONB value round-trip, and the load query are SQL-level
 * invariants the unit test's in-memory mock store *re-implements* rather than
 * verifies (MEMORY: mock-pool tests can't catch SQL planning errors). These run
 * the EXACT exported production SQL constants — plus the `loadSessionMemory`
 * helper end-to-end — against a real Postgres, so a planning/semantic error or a
 * value-fidelity regression is caught.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `chat-cap-pg` /
 * `migrate-pg`). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import {
  SESSION_MEMORY_UPSERT_SQL,
  loadSessionMemory,
} from "@atlas/api/lib/durable-state";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TIMEOUT_MS = 30_000;

describeIfPg("durable session memory SQL (real Postgres, #3754)", () => {
  let pool: Pool;
  let conversationId: string;
  const schemaName = `durmem_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  /** Mirror `commitSessionMemory`'s exact param construction against the real SQL. */
  async function upsert(namespace: string, value: unknown, org: string | null): Promise<void> {
    await pool.query(SESSION_MEMORY_UPSERT_SQL, [
      conversationId,
      org,
      namespace,
      JSON.stringify(value ?? null),
    ]);
  }

  async function orgOf(namespace: string): Promise<string | null> {
    const r = await pool.query<{ org_id: string | null }>(
      `SELECT org_id FROM agent_session_memory WHERE conversation_id = $1 AND namespace = $2`,
      [conversationId, namespace],
    );
    return r.rows[0]?.org_id ?? null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`durable-state-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // FK parent: a session row. All conversations columns are nullable or
    // defaulted, so id-only insert suffices.
    const conv = await pool.query<{ id: string }>(
      `INSERT INTO conversations (id) VALUES (gen_random_uuid()) RETURNING id`,
    );
    conversationId = conv.rows[0]!.id;
    // Point the module helpers (loadSessionMemory → internalQuery) at this pool
    // and make hasInternalDB() true.
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM agent_session_memory`);
  });

  it("upserts a slot and loads it back through loadSessionMemory", async () => {
    await upsert("note", "hello", "org-1");
    const mem = await loadSessionMemory(conversationId);
    expect(mem.get("note")).toBe("hello");
  });

  it("last write wins for sequential same-slot writes; ON CONFLICT keeps one row", async () => {
    await upsert("note", "A", "org-1");
    await upsert("note", "B", "org-1");
    const mem = await loadSessionMemory(conversationId);
    expect(mem.get("note")).toBe("B");
    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_session_memory WHERE conversation_id = $1 AND namespace = 'note'`,
      [conversationId],
    );
    expect(count.rows[0]!.n).toBe("1");
  });

  it("round-trips a nested JSON value with fidelity through JSONB", async () => {
    const value = { a: [1, { b: 2 }], c: "x", d: null };
    await upsert("obj", value, "org-1");
    const mem = await loadSessionMemory(conversationId);
    expect(mem.get("obj")).toEqual(value);
  });

  it("COALESCE keeps a known org_id when a later write carries null", async () => {
    await upsert("note", "v1", "org-1");
    expect(await orgOf("note")).toBe("org-1");
    await upsert("note", "v2", null); // a null-org write must NOT regress the tenant scope
    expect(await orgOf("note")).toBe("org-1");
    const mem = await loadSessionMemory(conversationId);
    expect(mem.get("note")).toBe("v2"); // ...but the value still updates
  });

  it("keeps distinct namespaces as separate rows within one session", async () => {
    await upsert("a", 1, "org-1");
    await upsert("b", 2, "org-1");
    const mem = await loadSessionMemory(conversationId);
    expect(mem.get("a")).toBe(1);
    expect(mem.get("b")).toBe(2);
    expect(mem.size).toBe(2);
  });
});
