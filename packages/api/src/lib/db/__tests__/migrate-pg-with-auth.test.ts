/**
 * Real-Postgres migration smoke INCLUDING Better-Auth-dependent
 * migrations (#2714).
 *
 * The companion `migrate-pg.test.ts` runs with
 * `skip: MANAGED_AUTH_MIGRATIONS` because Better Auth's `user`,
 * `session`, and `organization` tables don't exist in the test
 * fixture. That leaves the migrations in `MANAGED_AUTH_MIGRATIONS`
 * (0027 / 0042 / 0048 / 0050 / 0061 / 0090) without any real-Postgres
 * coverage — a regression that breaks one of those files would only
 * surface on the next production deploy.
 *
 * This suite bootstraps a minimal Better Auth schema first (`user`,
 * `session`, `organization` with the columns Atlas migrations
 * reference, plus enough primary-key / FK structure that the
 * Better-Auth-dependent ALTERs apply cleanly), then runs the FULL
 * Atlas migration set with no skip. Catches planner-level errors that
 * mock-pool tests can't see — same shape as the existing smoke, just
 * with the auth-table fixture in place.
 *
 * Hand-crafted DDL vs invoking Better Auth's own migrator: the test
 * focuses on Atlas migrations, not Better Auth's. Keeping the DDL
 * minimal means a Better Auth schema-shape change doesn't break this
 * test unless it actually intersects an Atlas migration. The set of
 * columns below comes from greping the six MANAGED migrations for
 * Better-Auth table references — anything new an Atlas migration adds
 * against `user` / `session` / `organization` should be exercised here
 * (or land in `MANAGED_AUTH_MIGRATIONS` with a stub update).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

/**
 * Minimal Better Auth bootstrap. Only the columns Atlas migrations
 * touch — keeps the test surface focused on what Atlas needs.
 *
 *   - `user.id` — FK target for 0048's `trusted_device.user_id`
 *   - `user.emailVerified` — UPDATEd by 0050 backfill
 *   - `session.userId` — read by 0050 to scope the backfill
 *   - `organization.id` — ALTERed by 0027 / 0042 / 0090
 *
 * IF NOT EXISTS so re-running in a long-lived schema (e.g. shared CI
 * Postgres across shards) is idempotent. PG_TEST_TIMEOUT_MS budget is
 * already in place for the full migration set.
 */
const BETTER_AUTH_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    token TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

describeIfPg("migrate-pg-with-auth (real Postgres, Better Auth tables present)", () => {
  let pool: Pool;
  const schemaName = `boot_smoke_auth_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `migrate-pg-with-auth: SET search_path failed on new connection: ${message}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await pool.query(BETTER_AUTH_BOOTSTRAP_SQL);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it(
    "runs every migration end-to-end including MANAGED_AUTH_MIGRATIONS",
    async () => {
      // No `skip` arg — applies the full set including the six
      // Better-Auth-dependent migrations. A regression that breaks one
      // of them (planner error, missing column reference, FK to a
      // table that doesn't exist) fails the suite with the underlying
      // SQL error attached.
      const count = await runMigrations(pool);
      expect(count).toBeGreaterThan(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is idempotent — re-running applies zero new migrations",
    async () => {
      const count = await runMigrations(pool);
      expect(count).toBe(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 0090 column-round-trip — the AC test from the issue body ──
  //
  // Confirms the `is_operator_workspace` column added by migration
  // 0090 is queryable end-to-end. A regression that drops or renames
  // the column fails this test loudly — exactly the scenario #2714
  // was filed to catch.
  it(
    "0090: is_operator_workspace column accepts and round-trips a true value",
    async () => {
      await pool.query(
        `INSERT INTO organization (id, name, slug, is_operator_workspace)
         VALUES ($1, $2, $3, $4)`,
        ["org-operator-1", "Atlas Operator Workspace", "atlas-operator", true],
      );

      const result = await pool.query<{
        is_operator_workspace: boolean;
        plan_tier: string;
        workspace_status: string;
      }>(
        `SELECT is_operator_workspace, plan_tier, workspace_status
           FROM organization
          WHERE id = $1`,
        ["org-operator-1"],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.is_operator_workspace).toBe(true);
      // 0027 added plan_tier with default 'free' — pins that the
      // managed migrations applied in the right order (the column
      // must exist + carry its default).
      expect(result.rows[0]?.plan_tier).toBe("free");
      expect(result.rows[0]?.workspace_status).toBe("active");

      // Default for non-operator rows is false — sanity-pin the
      // migration's `DEFAULT false` clause.
      await pool.query(
        `INSERT INTO organization (id, name, slug)
         VALUES ($1, $2, $3)`,
        ["org-customer-1", "Customer Workspace", "customer"],
      );
      const customer = await pool.query<{
        is_operator_workspace: boolean;
      }>(
        `SELECT is_operator_workspace FROM organization WHERE id = $1`,
        ["org-customer-1"],
      );
      expect(customer.rows[0]?.is_operator_workspace).toBe(false);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 0061 column-round-trip ──
  it(
    "0061: user.default_landing column accepts 'chat' default",
    async () => {
      await pool.query(
        `INSERT INTO "user" (id, email) VALUES ($1, $2)`,
        ["u-test-1", "test@example.com"],
      );
      const result = await pool.query<{ default_landing: string }>(
        `SELECT default_landing FROM "user" WHERE id = $1`,
        ["u-test-1"],
      );
      expect(result.rows[0]?.default_landing).toBe("chat");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 0048 FK constraint pins ──
  it(
    "0048: trusted_device FK to user enforces ON DELETE CASCADE",
    async () => {
      await pool.query(
        `INSERT INTO "user" (id, email) VALUES ($1, $2)`,
        ["u-trusted-1", "trusted@example.com"],
      );
      await pool.query(
        `INSERT INTO trusted_device (identifier, user_id) VALUES ($1, $2)`,
        ["device-cookie-1", "u-trusted-1"],
      );
      // CASCADE: deleting the user should remove the trusted_device row
      await pool.query(`DELETE FROM "user" WHERE id = $1`, ["u-trusted-1"]);
      const result = await pool.query(
        `SELECT identifier FROM trusted_device WHERE identifier = $1`,
        ["device-cookie-1"],
      );
      expect(result.rows).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
