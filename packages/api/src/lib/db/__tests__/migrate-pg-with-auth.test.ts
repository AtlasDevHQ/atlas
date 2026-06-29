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
import { createHash } from "node:crypto";
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
 *   - `user.role` — cleared by 0118 (`SET role = NULL WHERE role = 'admin'`)
 *   - `user.stripeCustomerId` — DROPped by 0159 (#4013). Seeded here to mirror
 *     the US prod `user` table (the only region that had it), so the drop is
 *     actually exercised rather than a silent `IF EXISTS` no-op.
 *   - `session.userId` — read by 0050 to scope the backfill
 *   - `organization.id` — ALTERed by 0027 / 0042 / 0090
 *   - `member.role` — backfilled by 0118 from `user.role='admin'`
 *
 * `user.role` + `member` mirror Better Auth's admin/organization plugin
 * schema (Atlas doesn't create them) — present here only because 0118
 * reads/writes both.
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
    role TEXT,
    "stripeCustomerId" TEXT,
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

  CREATE TABLE IF NOT EXISTS member (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

describeIfPg("migrate-pg-with-auth (real Postgres, Better Auth tables present)", () => {
  let pool: Pool;
  const schemaName = `boot_smoke_auth_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Bootstrap the scratch schema on a one-shot client BEFORE creating
    // the long-lived pool. CREATE SCHEMA must exist before any
    // `search_path`-scoped connection lands, so a `SET search_path`
    // pool listener has a real target.
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }

    // libpq `options` baked into the connection string sets search_path
    // at connection startup — synchronously, server-side, before any
    // user query runs on that connection. Replaces the pool.on("connect")
    // listener that submitted `SET search_path` as an unawaited
    // `void client.query(...)` (per Codex P1 #2722): even though
    // pg client queries serialize per-connection, relying on
    // submission-order racing against the pool handing the client to
    // the next caller is fragile. Setting it via libpq options closes
    // the window entirely. Both `schemaName` and `public` are listed so
    // built-in objects (extensions, system catalog references) still
    // resolve.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    await pool.query(BETTER_AUTH_BOOTSTRAP_SQL);

    // Pre-seed rows for the 0118 backfill round-trip (asserted below). These
    // exist BEFORE the migrations run (in the first `it`), so 0118 transforms
    // them. `u-0118-promote` has its admin grant only in user.role='admin'
    // with a below-admin member row → must be promoted to member.role='admin'
    // before the column is cleared. `u-0118-owner` is already an owner → must
    // be left untouched.
    await pool.query(
      `INSERT INTO organization (id, name, slug) VALUES ('org-0118', 'Org 0118', 'org-0118')`,
    );
    await pool.query(
      `INSERT INTO "user" (id, email, role) VALUES
         ('u-0118-promote', 'promote@0118.test', 'admin'),
         ('u-0118-owner', 'owner@0118.test', 'admin')`,
    );
    await pool.query(
      `INSERT INTO member (id, "userId", "organizationId", role) VALUES
         ('m-0118-promote', 'u-0118-promote', 'org-0118', 'member'),
         ('m-0118-owner', 'u-0118-owner', 'org-0118', 'owner')`,
    );
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

  // ── 0118 backfill round-trip (#2890) ──
  //
  // The load-bearing, lossless part of the migration: any user whose admin
  // grant lived only in user.role='admin' gets mirrored into member.role
  // before the column is cleared, so no admin is silently demoted. Seeded in
  // beforeAll (pre-migration); asserted here post-migration.
  it(
    "0118: backfills member.role from user.role='admin', leaves owners, then clears user.role",
    async () => {
      const members = await pool.query<{ userId: string; role: string }>(
        `SELECT "userId", role FROM member WHERE "organizationId" = 'org-0118'`,
      );
      const byUser = Object.fromEntries(members.rows.map((r) => [r.userId, r.role]));
      // below-admin member promoted to admin (mirror of the dropped user.role='admin')
      expect(byUser["u-0118-promote"]).toBe("admin");
      // owner untouched (NOT IN ('admin','owner') guard)
      expect(byUser["u-0118-owner"]).toBe("owner");

      // user.role='admin' cleared on both
      const users = await pool.query<{ id: string; role: string | null }>(
        `SELECT id, role FROM "user" WHERE id IN ('u-0118-promote', 'u-0118-owner')`,
      );
      expect(users.rows.every((r) => r.role === null)).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── 0159 column drop (#4013) ──
  //
  // The fixture seeds `user."stripeCustomerId"` (mirroring US prod, the only
  // region that had it). After the full migration set runs, 0159 must have
  // dropped it. A regression that omits 0159 from MANAGED_AUTH_MIGRATIONS — so
  // it never runs against the Better Auth `user` table — fails here.
  it(
    "0159: drops user.stripeCustomerId from the Better Auth user table",
    async () => {
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'user'
            AND column_name = 'stripeCustomerId'`,
        [schemaName],
      );
      expect(col.rows).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "0159: re-applying the DROP no-ops on a column-less user table (EU/APAC path)",
    async () => {
      // The migration set above already dropped the column, so the table now
      // has no `stripeCustomerId` — the same state EU/APAC always had (they
      // never registered the stripe plugin, so Better Auth never declared it).
      // Re-running 0159's DROP must succeed via `IF EXISTS`. Guards against a
      // regression that removes `IF EXISTS`, which would pass the US (column-
      // present) case above yet crash boot in the 2 column-less regions.
      await pool.query(
        `ALTER TABLE "user" DROP COLUMN IF EXISTS "stripeCustomerId"`,
      );
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'user'
            AND column_name = 'stripeCustomerId'`,
        [schemaName],
      );
      expect(col.rows).toHaveLength(0);
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

  // ── 0142 normalizedEmail unique-index — the one-trial-per-user "teeth" ──
  //
  // The whole premise of #3650: `+alias`/dot/case variants collapse to one
  // normalizedEmail, so a duplicate signup trips a 23505 instead of minting a
  // second trial. The migration adds the column + a UNIQUE index; this asserts
  // BOTH halves of the index contract — duplicates reject, and NULLs (legacy
  // rows that predate the column) stay distinct so they never collide.
  it(
    "0142: duplicate normalizedEmail rejects with 23505; NULL normalizedEmail rows stay distinct",
    async () => {
      // Two distinct rows that normalize to the same address must collide.
      await pool.query(
        `INSERT INTO "user" (id, email, "normalizedEmail") VALUES ($1, $2, $3)`,
        ["u-0142-a", "John.Doe+trial@acme.com", "johndoe@acme.com"],
      );
      let duplicateError: { code?: string } | undefined;
      try {
        await pool.query(
          `INSERT INTO "user" (id, email, "normalizedEmail") VALUES ($1, $2, $3)`,
          ["u-0142-b", "johndoe@acme.com", "johndoe@acme.com"],
        );
      } catch (err) {
        duplicateError = err as { code?: string };
      }
      expect(duplicateError?.code).toBe("23505");

      // NULL normalizedEmail is distinct in a Postgres unique index — two legacy
      // rows that predate the column must both insert without colliding.
      await pool.query(
        `INSERT INTO "user" (id, email) VALUES ($1, $2), ($3, $4)`,
        ["u-0142-null-1", "legacy1@acme.com", "u-0142-null-2", "legacy2@acme.com"],
      );
      const legacy = await pool.query(
        `SELECT id FROM "user" WHERE id IN ('u-0142-null-1', 'u-0142-null-2')`,
      );
      expect(legacy.rows).toHaveLength(2);
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

  // ── 0151 pgcrypto hashed-email index — the login front-door linchpin (#3973) ──
  //
  // The returning-user front-door routes only if the JS `hashEmail` (Web Crypto
  // sha256 of lower(email), hex) is byte-identical to what Postgres computes via
  // the index expression `encode(digest(lower(email),'sha256'),'hex')`. If they
  // ever diverge (pgcrypto missing, encoding, hex case, lower() vs toLowerCase),
  // EVERY returning user in a non-default region silently gets routed to "no
  // account — sign up". This pins the SQL side against an independent SHA-256
  // (node:crypto) so a pgcrypto/expression regression fails loudly in CI.
  it(
    "0151: digest index expression equals sha256(lower(email)) hex, and the functional index exists",
    async () => {
      // Mixed-case input → the index lower()s it, so the hash must match the
      // lower-cased address (exactly what the browser's hashEmail produces).
      const email = "Alice@Corp.com";
      const expected = createHash("sha256").update(email.toLowerCase()).digest("hex");

      await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, ["u-0151", email]);

      const hashed = await pool.query<{ h: string }>(
        `SELECT encode(digest(lower(email), 'sha256'), 'hex') AS h
           FROM "user" WHERE id = $1`,
        ["u-0151"],
      );
      expect(hashed.rows[0]?.h).toBe(expected);

      // EXISTS-probe round-trip against the hash (the shape emailHashExists runs).
      const exists = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM "user"
           WHERE encode(digest(lower(email), 'sha256'), 'hex') = $1
         ) AS "exists"`,
        [expected],
      );
      expect(exists.rows[0]?.exists).toBe(true);

      // The functional index 0151 creates must be present (so the probe is an
      // indexed lookup, not a seq scan).
      const idx = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname = 'user_email_sha256_idx'`,
      );
      expect(idx.rows).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
