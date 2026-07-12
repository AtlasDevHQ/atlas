/**
 * Real-Postgres tests for learned-pattern injection attribution (#4573, v0.0.50).
 *
 * Migration 0173 adds `learned_pattern_injections` (one row per (pattern, turn)
 * injection) and `recordPatternInjections` writes it fire-and-forget. Three
 * properties only assertable against real Postgres:
 *   - the production INSERT lands the batch with the right scope columns;
 *   - the `pattern_id` FK CASCADE reaps attribution when a pattern is deleted
 *     (so the cockpit count can never reference a deleted pattern);
 *   - the cockpit's 30-day count subquery (INJECTION_COUNT_SELECT) windows to
 *     the trailing 30 days.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches the peer -pg
 * suites). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  _resetCircuitBreaker,
  recordPatternInjections,
  type InternalPool,
} from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-injection-test";

describeIfPg("learned-pattern injection attribution (real Postgres, #4573)", () => {
  let pool: Pool;
  const schemaName = `injections_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`learned-pattern-injections-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Point the production internal-DB helpers at this pool so the exact INSERT
    // in `recordPatternInjections` runs against this schema.
    _resetPool(pool as unknown as InternalPool);
    _resetCircuitBreaker();
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    _resetPool(null);
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    _resetCircuitBreaker();
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

  async function injectionRows(patternId: string) {
    const res = await pool.query<{
      pattern_id: string;
      org_id: string | null;
      connection_group_id: string | null;
      conversation_id: string | null;
      request_id: string | null;
    }>(
      `SELECT pattern_id, org_id, connection_group_id, conversation_id, request_id
         FROM learned_pattern_injections WHERE pattern_id = $1`,
      [patternId],
    );
    return res.rows;
  }

  /** recordPatternInjections is fire-and-forget (returns void), so poll until
   *  the expected count lands rather than sleeping a fixed interval. */
  async function pollCount(patternId: string, want: number, timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
      const res = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM learned_pattern_injections WHERE pattern_id = $1`,
        [patternId],
      );
      last = parseInt(res.rows[0].n, 10);
      if (last === want) return last;
      await new Promise((r) => setTimeout(r, 10));
    }
    return last;
  }

  it("records one attribution row per injected pattern, with scope columns", async () => {
    const idA = await seedPattern("SELECT 1", { group: "us-prod" });
    const idB = await seedPattern("SELECT 2", { group: "us-prod" });

    recordPatternInjections([
      { patternId: idA, orgId: ORG, connectionGroupId: "us-prod", conversationId: "conv-1", requestId: "req-1" },
      { patternId: idB, orgId: ORG, connectionGroupId: "us-prod", conversationId: "conv-1", requestId: "req-1" },
    ]);

    expect(await pollCount(idA, 1)).toBe(1);
    expect(await pollCount(idB, 1)).toBe(1);

    const [rowA] = await injectionRows(idA);
    expect(rowA.org_id).toBe(ORG);
    expect(rowA.connection_group_id).toBe("us-prod");
    expect(rowA.conversation_id).toBe("conv-1");
    expect(rowA.request_id).toBe("req-1");
  });

  it("persists NULL scope for a legacy global/default-group pattern", async () => {
    const id = await seedPattern("SELECT 3", { org: null, group: null });
    recordPatternInjections([
      { patternId: id, orgId: null, connectionGroupId: null, conversationId: null, requestId: null },
    ]);
    expect(await pollCount(id, 1)).toBe(1);
    const [row] = await injectionRows(id);
    expect(row.org_id).toBeNull();
    expect(row.connection_group_id).toBeNull();
    expect(row.conversation_id).toBeNull();
  });

  it("CASCADEs attribution rows when the pattern is deleted", async () => {
    const id = await seedPattern("SELECT 4");
    recordPatternInjections([
      { patternId: id, orgId: ORG, connectionGroupId: null, conversationId: "c", requestId: "r" },
    ]);
    expect(await pollCount(id, 1)).toBe(1);

    await pool.query(`DELETE FROM learned_patterns WHERE id = $1`, [id]);

    const res = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM learned_pattern_injections WHERE pattern_id = $1`,
      [id],
    );
    expect(parseInt(res.rows[0].n, 10)).toBe(0);
  });

  it("30-day count subquery windows out injections older than 30 days", async () => {
    const id = await seedPattern("SELECT 5");
    // One recent injection via the production writer.
    recordPatternInjections([
      { patternId: id, orgId: ORG, connectionGroupId: null, conversationId: "c", requestId: "r" },
    ]);
    expect(await pollCount(id, 1)).toBe(1);
    // One injection stamped 40 days ago (can't set injected_at through the
    // writer — it defaults to now() — so insert it directly).
    await pool.query(
      `INSERT INTO learned_pattern_injections (pattern_id, org_id, injected_at)
       VALUES ($1, $2, now() - interval '40 days')`,
      [id, ORG],
    );

    // The cockpit subquery (INJECTION_COUNT_SELECT) counts only the last 30 days.
    const windowed = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM learned_pattern_injections
        WHERE pattern_id = $1 AND injected_at >= now() - interval '30 days'`,
      [id],
    );
    expect(windowed.rows[0].n).toBe(1);

    // Sanity: the all-time count sees both.
    const all = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM learned_pattern_injections WHERE pattern_id = $1`,
      [id],
    );
    expect(parseInt(all.rows[0].n, 10)).toBe(2);
  });

  it("an empty batch is a no-op (no rows, no error)", async () => {
    const id = await seedPattern("SELECT 6");
    recordPatternInjections([]);
    // Nothing to poll for; give the (absent) write a beat and confirm zero rows.
    await new Promise((r) => setTimeout(r, 50));
    expect(await pollCount(id, 0, 200)).toBe(0);
  });
});
