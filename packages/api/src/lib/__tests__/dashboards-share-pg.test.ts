/**
 * Real-Postgres coverage for the #4317 token-rotation SQL in `shareDashboard`.
 *
 * The mock-pool tests in `dashboards-share.test.ts` only feed canned rows back
 * through the JS wrapper — they never execute the rewritten statement: the
 * `WITH prev AS (...)` CTE, the `src`/`d` alias split, the `UPDATE ... FROM prev`
 * join, and the `CASE WHEN $rotate OR prev.old_token IS NULL THEN $new ELSE
 * prev.old_token END` preserve-vs-rotate decision. Those are exactly the parts a
 * wrong alias / inverted CASE / accidental cross-join would break, and nothing
 * else in the suite would catch it. This runs the ACTUAL SQL against the real
 * schema.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset. Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { shareDashboard } from "@atlas/api/lib/dashboards";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("shareDashboard token rotation (real Postgres, #4317)", () => {
  let pool: Pool;
  const schemaName = `share_rotate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(`share-rotate-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(`share-rotate-pg: DROP SCHEMA cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM dashboards`);
  });

  /** Insert a dashboard and return its id. `token` seeds an existing share. */
  async function insertDashboard(opts: { orgId: string | null; token?: string | null }): Promise<string> {
    const rows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title, share_token, share_mode)
       VALUES ($1, 'owner-1', 'Test Dashboard', $2, 'public')
       RETURNING id`,
      [opts.orgId, opts.token ?? null],
    );
    return rows.rows[0]!.id;
  }

  async function readToken(id: string): Promise<string | null> {
    const rows = await pool.query<{ share_token: string | null }>(
      `SELECT share_token FROM dashboards WHERE id = $1`,
      [id],
    );
    return rows.rows[0]!.share_token;
  }

  it("mints a token on first-time share and does not flag rotated", async () => {
    const id = await insertDashboard({ orgId: "org-A", token: null });

    const result = await shareDashboard(id, { orgId: "org-A" }, { shareMode: "public" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.token).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(result.data.rotated).toBe(false);
    expect(await readToken(id)).toBe(result.data.token);
  });

  it("PRESERVES the existing token when editing expiry without rotate", async () => {
    const id = await insertDashboard({ orgId: "org-A", token: "keep-me-token-00000000" });

    const result = await shareDashboard(id, { orgId: "org-A" }, { expiresIn: "24h", shareMode: "public" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The CASE kept the prior token; only the expiry changed.
    expect(result.data.token).toBe("keep-me-token-00000000");
    expect(result.data.rotated).toBe(false);
    expect(await readToken(id)).toBe("keep-me-token-00000000");
  });

  it("mints a NEW token and flags rotated=true on explicit rotate", async () => {
    const id = await insertDashboard({ orgId: "org-A", token: "old-token-0000000000000" });

    const result = await shareDashboard(id, { orgId: "org-A" }, { shareMode: "public", rotate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.token).not.toBe("old-token-0000000000000");
    expect(result.data.token).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(result.data.rotated).toBe(true);
    // The old link is dead — the DB now holds only the new token.
    expect(await readToken(id)).toBe(result.data.token);
  });

  it("preserves the token for a null-org (self-hosted) dashboard on edit", async () => {
    // The `org_id IS NULL` branch of orgScopeClause — the common self-hosted
    // path where no org context exists.
    const id = await insertDashboard({ orgId: null, token: "selfhost-token-0000000" });

    const result = await shareDashboard(id, { orgId: null }, { expiresIn: "7d", shareMode: "public" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.token).toBe("selfhost-token-0000000");
    expect(result.data.rotated).toBe(false);
    expect(await readToken(id)).toBe("selfhost-token-0000000");
  });

  it("does not touch a dashboard outside the caller's org scope", async () => {
    const id = await insertDashboard({ orgId: "org-A", token: "org-a-token-000000000000" });

    // Caller scoped to org-B — the CTE's org clause matches no row.
    const result = await shareDashboard(id, { orgId: "org-B" }, { shareMode: "public", rotate: true });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    // The org-A token is untouched — no cross-tenant write.
    expect(await readToken(id)).toBe("org-a-token-000000000000");
  });
});
