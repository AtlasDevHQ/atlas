/**
 * Real-Postgres tests for the learned-pattern injection-attribution table
 * (#4573, v0.0.50, migration 0173).
 *
 * These pin the DB-level guarantees the cockpit count relies on and that only a
 * real Postgres can prove:
 *   - the table's columns + defaults;
 *   - the `pattern_id` FK CASCADE reaps attribution when a pattern is deleted
 *     (so the cockpit count can never reference a deleted pattern — the reason
 *     the migration uses ON DELETE CASCADE);
 *   - the cockpit's 30-day count subquery (INJECTION_COUNT_SELECT in
 *     admin-learned-patterns.ts) windows to the trailing 30 days;
 *   - NULL org/group scope persists (a legacy global/default-group pattern).
 *
 * Rows are inserted with direct `pool.query` (not the fire-and-forget
 * `recordPatternInjections`) so the assertions are deterministic against this
 * test's schema — the writer's SQL shape and its call-on-injection are pinned
 * separately by `internal.test.ts` and `org-knowledge-section.test.ts`.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches the peer -pg
 * suites). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-injection-test";

describeIfPg("learned-pattern injection attribution table (real Postgres, #4573)", () => {
  let pool: Pool;
  const schemaName = `injections_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Pin search_path at connection STARTUP (libpq `options`), not a
    // fire-and-forget `SET` on `connect` — so a fresh pooled connection never
    // reads/writes the wrong schema (mirrors approved-patterns-injection-
    // scoping-pg). `CREATE SCHEMA` below is explicit.
    pool = new Pool({ connectionString: TEST_DB_URL, options: `-c search_path=${schemaName}` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    // learned_patterns CASCADE clears learned_pattern_injections too.
    await pool.query("DELETE FROM learned_patterns");
  });

  /** Seed a query pattern and return its id — the FK target for attribution. */
  async function seedPattern(
    sql: string,
    opts: { org?: string | null; group?: string | null } = {},
  ): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO learned_patterns (org_id, connection_group_id, pattern_sql, source_entity)
       VALUES ($1, $2, $3, 't') RETURNING id`,
      [opts.org === undefined ? ORG : opts.org, opts.group ?? null, sql],
    );
    return res.rows[0].id;
  }

  /** Insert one attribution row directly (deterministic, this schema). */
  async function attribute(
    patternId: string,
    opts: {
      org?: string | null;
      group?: string | null;
      conversationId?: string | null;
      requestId?: string | null;
      injectedAtSql?: string;
    } = {},
  ): Promise<void> {
    const injectedAt = opts.injectedAtSql ?? "now()";
    await pool.query(
      `INSERT INTO learned_pattern_injections
         (pattern_id, org_id, connection_group_id, conversation_id, request_id, injected_at)
       VALUES ($1, $2, $3, $4, $5, ${injectedAt})`,
      [
        patternId,
        opts.org === undefined ? ORG : opts.org,
        opts.group ?? null,
        // `=== undefined` (not `??`): an explicit `null` must persist as NULL,
        // not fall back to the default.
        opts.conversationId === undefined ? "conv-1" : opts.conversationId,
        opts.requestId === undefined ? "req-1" : opts.requestId,
      ],
    );
  }

  it("stores an attribution row with its scope + turn columns and a default injected_at", async () => {
    const id = await seedPattern("SELECT 1", { group: "us-prod" });
    await attribute(id, { group: "us-prod", conversationId: "conv-9", requestId: "req-9" });

    const res = await pool.query<{
      pattern_id: string;
      org_id: string | null;
      connection_group_id: string | null;
      conversation_id: string | null;
      request_id: string | null;
      injected_at: Date;
    }>(`SELECT * FROM learned_pattern_injections WHERE pattern_id = $1`, [id]);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.org_id).toBe(ORG);
    expect(row.connection_group_id).toBe("us-prod");
    expect(row.conversation_id).toBe("conv-9");
    expect(row.request_id).toBe("req-9");
    expect(row.injected_at).toBeInstanceOf(Date);
  });

  it("persists NULL scope for a legacy global/default-group pattern", async () => {
    const id = await seedPattern("SELECT 2", { org: null, group: null });
    await attribute(id, { org: null, group: null, conversationId: null, requestId: null });
    const res = await pool.query<{ org_id: string | null; connection_group_id: string | null; conversation_id: string | null }>(
      `SELECT org_id, connection_group_id, conversation_id FROM learned_pattern_injections WHERE pattern_id = $1`,
      [id],
    );
    expect(res.rows[0].org_id).toBeNull();
    expect(res.rows[0].connection_group_id).toBeNull();
    expect(res.rows[0].conversation_id).toBeNull();
  });

  it("CASCADEs attribution rows when the pattern is deleted", async () => {
    const id = await seedPattern("SELECT 3");
    await attribute(id);
    await attribute(id);
    const before = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM learned_pattern_injections WHERE pattern_id = $1`,
      [id],
    );
    expect(parseInt(before.rows[0].n, 10)).toBe(2);

    await pool.query(`DELETE FROM learned_patterns WHERE id = $1`, [id]);

    const after = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM learned_pattern_injections WHERE pattern_id = $1`,
      [id],
    );
    expect(parseInt(after.rows[0].n, 10)).toBe(0);
  });

  it("the 30-day count subquery windows out injections older than 30 days", async () => {
    const id = await seedPattern("SELECT 4");
    await attribute(id); // recent (now)
    await attribute(id, { injectedAtSql: "now() - interval '40 days'" }); // stale

    // Exactly the cockpit subquery (INJECTION_COUNT_SELECT).
    const windowed = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM learned_pattern_injections
        WHERE pattern_id = $1 AND injected_at >= now() - interval '30 days'`,
      [id],
    );
    expect(windowed.rows[0].n).toBe(1);

    const all = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM learned_pattern_injections WHERE pattern_id = $1`,
      [id],
    );
    expect(parseInt(all.rows[0].n, 10)).toBe(2);
  });

  it("rejects an attribution row whose pattern_id has no learned_patterns parent (FK)", async () => {
    await expect(
      pool.query(
        `INSERT INTO learned_pattern_injections (pattern_id) VALUES ('00000000-0000-0000-0000-000000000000')`,
      ),
    ).rejects.toThrow();
  });
});
