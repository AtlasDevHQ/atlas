/**
 * Real-Postgres coverage for the anonymous demo principal's ledger (#5604):
 * migration 0215's `demo_anonymous_sessions`, the slug-resolved demo
 * workspace (fail-closed), the answer counter, and the after-first-answer
 * email gate — all against the ACTUAL SQL the lib runs.
 *
 * Why real Postgres: the launch-cycle gate reads this table with its own
 * `SELECT count(*) … WHERE created_at >= <date>`, and the email gate is a
 * single-row `answer_count` read — a mocked `internalQuery` would pin the
 * strings the lib sends, not what the schema returns.
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
import {
  _resetDemoWorkspaceCacheForTests,
  captureAnonymousDemoEmail,
  hashDemoIp,
  loadAnonymousDemoSession,
  recordAnonymousDemoAnswer,
  resolveDemoWorkspaceId,
  startAnonymousDemoSession,
} from "@atlas/api/lib/demo-anonymous";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;
const DEMO_ORG = "org_demo_5604";

describeIfPg("anonymous demo sessions (real Postgres, #5604)", () => {
  let pool: Pool;
  const schemaName = `demo_anon_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;
  const ORIGINAL_SLUG = process.env.ATLAS_DEMO_WORKSPACE_SLUG;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `demo-anonymous-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // `organization` is Better Auth's table (not a migration); the slug lookup
    // needs only these three columns.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS organization (id text PRIMARY KEY, slug text, deleted_at timestamptz)`,
    );

    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-32-chars-long";
    delete process.env.ATLAS_DEMO_WORKSPACE_SLUG;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_SLUG === undefined) delete process.env.ATLAS_DEMO_WORKSPACE_SLUG;
    else process.env.ATLAS_DEMO_WORKSPACE_SLUG = ORIGINAL_SLUG;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(
        `demo-anonymous-pg: DROP SCHEMA cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await pool.end();
  });

  beforeEach(async () => {
    _resetDemoWorkspaceCacheForTests();
    await pool.query(`DELETE FROM demo_anonymous_sessions`);
    await pool.query(`DELETE FROM demo_leads`);
    await pool.query(`DELETE FROM organization`);
    await pool.query(`INSERT INTO organization (id, slug) VALUES ($1, 'novamart-demo')`, [DEMO_ORG]);
  });

  describe("resolveDemoWorkspaceId — by slug, fail closed", () => {
    it("resolves the organization carrying the slug", async () => {
      const r = await resolveDemoWorkspaceId();
      expect(r).toEqual({ ok: true, id: DEMO_ORG, slug: "novamart-demo" });
    });

    it("refuses when no organization carries the slug (not_found), and does not cache the miss", async () => {
      await pool.query(`DELETE FROM organization`);
      expect(await resolveDemoWorkspaceId()).toEqual({ ok: false, reason: "not_found" });
      await pool.query(`INSERT INTO organization (id, slug) VALUES ($1, 'novamart-demo')`, [DEMO_ORG]);
      expect((await resolveDemoWorkspaceId()).ok).toBe(true);
    });

    it("ignores a soft-deleted organization", async () => {
      await pool.query(`UPDATE organization SET deleted_at = now() WHERE id = $1`, [DEMO_ORG]);
      expect(await resolveDemoWorkspaceId()).toEqual({ ok: false, reason: "not_found" });
    });

    it("follows the slug setting, not a stored id", async () => {
      await pool.query(`INSERT INTO organization (id, slug) VALUES ('org_other', 'other-demo')`);
      process.env.ATLAS_DEMO_WORKSPACE_SLUG = "other-demo";
      try {
        const r = await resolveDemoWorkspaceId();
        expect(r.ok && r.id).toBe("org_other");
      } finally {
        delete process.env.ATLAS_DEMO_WORKSPACE_SLUG;
      }
    });
  });

  describe("session rows", () => {
    it("mints a row whose id is the identity and whose created_at the launch-cycle gate can count", async () => {
      const expiresAt = Date.now() + 60_000;
      const session = await startAnonymousDemoSession({
        workspaceId: DEMO_ORG,
        ip: "203.0.113.9",
        clientLabel: "claude-desktop",
        expiresAt,
      });
      expect(session.workspaceId).toBe(DEMO_ORG);
      expect(session.answerCount).toBe(0);
      expect(session.emailCapturedAt).toBeNull();
      expect(Math.abs(session.expiresAt.getTime() - expiresAt)).toBeLessThan(1000);

      const counted = await pool.query<{ count: string }>(
        `SELECT count(*) FROM demo_anonymous_sessions WHERE created_at >= $1`,
        [new Date(Date.now() - 60_000).toISOString()],
      );
      expect(Number(counted.rows[0]?.count)).toBe(1);

      const loaded = await loadAnonymousDemoSession(session.id);
      expect(loaded?.id).toBe(session.id);
      expect(await loadAnonymousDemoSession("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("stores an IP HASH, never the raw IP, and truncates the client label", async () => {
      const ip = "203.0.113.10";
      const session = await startAnonymousDemoSession({
        workspaceId: DEMO_ORG,
        ip,
        clientLabel: "x".repeat(500),
        expiresAt: Date.now() + 60_000,
      });
      const row = await pool.query<{ ip_hash: string | null; client_label: string | null }>(
        `SELECT ip_hash, client_label FROM demo_anonymous_sessions WHERE id = $1`,
        [session.id],
      );
      expect(row.rows[0]?.ip_hash).toBe(hashDemoIp(ip));
      expect(row.rows[0]?.ip_hash).not.toContain("203.0.113");
      expect(row.rows[0]?.client_label?.length).toBe(200);
    });

    it("counts answers", async () => {
      const session = await startAnonymousDemoSession({
        workspaceId: DEMO_ORG,
        ip: null,
        clientLabel: null,
        expiresAt: Date.now() + 60_000,
      });
      await recordAnonymousDemoAnswer(session.id, "req-1");
      await recordAnonymousDemoAnswer(session.id, "req-2");
      expect((await loadAnonymousDemoSession(session.id))?.answerCount).toBe(2);
    });
  });

  describe("email capture — optional, after the first answer, never before", () => {
    it("refuses before the first answer, then accepts after one", async () => {
      const session = await startAnonymousDemoSession({
        workspaceId: DEMO_ORG,
        ip: "203.0.113.11",
        clientLabel: null,
        expiresAt: Date.now() + 60_000,
      });
      const before = await captureAnonymousDemoEmail({
        sessionId: session.id,
        email: "visitor@example.com",
        ip: "203.0.113.11",
        userAgent: null,
        requestId: "req-before",
      });
      expect(before).toEqual({ ok: false, reason: "answer_required" });
      const leadsBefore = await pool.query<{ count: string }>(`SELECT count(*) FROM demo_leads`);
      expect(Number(leadsBefore.rows[0]?.count)).toBe(0);

      await recordAnonymousDemoAnswer(session.id);

      const after = await captureAnonymousDemoEmail({
        sessionId: session.id,
        email: "Visitor@Example.com",
        ip: "203.0.113.11",
        userAgent: "test",
        requestId: "req-after",
      });
      expect(after).toEqual({ ok: true, returning: false });
      const leads = await pool.query<{ email: string }>(`SELECT email FROM demo_leads`);
      expect(leads.rows.map((r) => r.email)).toEqual(["visitor@example.com"]);
      expect((await loadAnonymousDemoSession(session.id))?.emailCapturedAt).not.toBeNull();
    });

    it("refuses an unknown session and a malformed email", async () => {
      expect(
        await captureAnonymousDemoEmail({
          sessionId: "00000000-0000-4000-8000-000000000000",
          email: "visitor@example.com",
          ip: null,
          userAgent: null,
          requestId: "req",
        }),
      ).toEqual({ ok: false, reason: "session_not_found" });
      expect(
        await captureAnonymousDemoEmail({
          sessionId: "00000000-0000-4000-8000-000000000000",
          email: "not-an-email",
          ip: null,
          userAgent: null,
          requestId: "req",
        }),
      ).toEqual({ ok: false, reason: "invalid_email" });
    });
  });
});
