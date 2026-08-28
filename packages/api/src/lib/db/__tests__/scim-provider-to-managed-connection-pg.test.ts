/**
 * Real-Postgres tests for migration 0209 — carrying legacy `scimProvider`
 * rows into @better-auth/scim 1.7's managed-connection catalog (#5493).
 *
 * Why real Postgres: 0209 is a guarded `DO $$ ... $$` block whose value is
 * entirely in its WHERE clauses, its NOT EXISTS idempotency guard and its two
 * table-existence guards. A mocked query layer evaluates none of that — it
 * would report success against SQL that carries the wrong rows, duplicates on
 * a re-run, or throws on a deploy where SCIM was never enabled.
 *
 * The load-bearing assertions are the NEGATIVE ones:
 *
 *   - personal (org-less) providers are NOT carried. `provisioningDomainId` is
 *     NOT NULL and means the receiving organization; a provider without one has
 *     no coherent destination. These are exactly the rows GHSA-j8v8-g9cx-5qf4
 *     was about and 0184 sealed.
 *   - NO credential rows are created. 1.6 stored tokens encrypted, 1.7 stores
 *     HMAC digests, and the recorded decision is to rotate rather than carry.
 *     A test that only checked "the connection appeared" would pass against a
 *     migration that invented a credential — which would look like working
 *     provisioning while authenticating nothing.
 *   - a re-run carries nothing twice.
 *   - both tables are plugin-owned, so each guard must no-op rather than error.
 *
 * Both tables are stood up here rather than relying on a prior migration,
 * because neither belongs to the Atlas runner: `scimProvider` exists only
 * where 1.6 EE SCIM ran, `scimManagedConnection` only after 1.7's schema-diff
 * auto-migrate.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
/** The reserved non-existent owner 0184 stamps; 0209 keeps the same value. */
const SENTINEL = "00000000-0000-0000-0000-000000000000";

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "..", "migrations", "0209_scim_provider_to_managed_connection.sql"),
  "utf8",
);

describeIfPg("migration 0209 — carry scimProvider into the managed catalog (#5493)", () => {
  let pool: Pool;
  const schemaName = `scim0209_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`scim-provider-to-managed-connection-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // `gen_random_uuid()` is core since PG13, but be explicit rather than rely
    // on the test database's extension set.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  }, PG_TIMEOUT_MS);

  /** The 1.6 table, shaped as `providerOwnership: { enabled: true }` leaves it. */
  async function createLegacyTable(): Promise<void> {
    await pool.query(`DROP TABLE IF EXISTS "scimProvider"`);
    await pool.query(`
      CREATE TABLE "scimProvider" (
        id               text PRIMARY KEY,
        "providerId"     text NOT NULL,
        "organizationId" text,
        "userId"         text
      )
    `);
  }

  /** The 1.7 catalog table, with the columns the plugin declares as required. */
  async function createManagedTable(): Promise<void> {
    await pool.query(`DROP TABLE IF EXISTS "scimManagedConnection"`);
    await pool.query(`
      CREATE TABLE "scimManagedConnection" (
        id                      text PRIMARY KEY,
        "creationRequestId"     text NOT NULL UNIQUE,
        "connectionId"          text NOT NULL UNIQUE,
        "provisioningDomainId"  text NOT NULL,
        status                  text NOT NULL,
        revision                integer NOT NULL,
        "createdAt"             timestamptz NOT NULL,
        "createdBy"             text NOT NULL,
        "decommissionedAt"      timestamptz
      )
    `);
  }

  async function seedLegacy(rows: {
    id: string;
    providerId: string;
    organizationId: string | null;
    userId: string | null;
  }[]): Promise<void> {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO "scimProvider" (id, "providerId", "organizationId", "userId")
         VALUES ($1, $2, $3, $4)`,
        [r.id, r.providerId, r.organizationId, r.userId],
      );
    }
  }

  const runMigration = () => pool.query(MIGRATION_SQL);

  beforeEach(async () => {
    await createLegacyTable();
    await createManagedTable();
  }, PG_TIMEOUT_MS);

  it("carries an org-scoped provider, preserving its identity and owner", async () => {
    await seedLegacy([
      { id: "sp_1", providerId: "okta-prod", organizationId: "org_a", userId: "usr_admin" },
    ]);

    await runMigration();

    const { rows } = await pool.query(
      `SELECT "connectionId", "provisioningDomainId", status, revision, "createdBy", "creationRequestId"
         FROM "scimManagedConnection"`,
    );
    expect(rows).toHaveLength(1);
    // The IdP-facing id must survive: it is what the customer configured.
    expect(rows[0].connectionId).toBe("okta-prod");
    // 1.6's `organizationId` is 1.7's `provisioningDomainId`.
    expect(rows[0].provisioningDomainId).toBe("org_a");
    expect(rows[0].status).toBe("active");
    expect(rows[0].revision).toBe(1);
    // The real owner is preserved rather than replaced by the sentinel.
    expect(rows[0].createdBy).toBe("usr_admin");
    // Derived from the source row, not random — that is what makes a re-run
    // collide with itself instead of inserting a twin.
    expect(rows[0].creationRequestId).toBe("0209-migrated-sp_1");
  }, PG_TIMEOUT_MS);

  it("creates NO credential — rotation is the recorded decision, not carry-over", async () => {
    await seedLegacy([
      { id: "sp_1", providerId: "okta-prod", organizationId: "org_a", userId: "usr_admin" },
    ]);
    // Stand the credential table up so its emptiness afterwards is a real
    // observation rather than an artefact of the table not existing.
    await pool.query(`DROP TABLE IF EXISTS "scimManagedCredential"`);
    await pool.query(`
      CREATE TABLE "scimManagedCredential" (
        id text PRIMARY KEY,
        "connectionRecordId" text NOT NULL,
        "tokenDigest" text NOT NULL
      )
    `);

    await runMigration();

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "scimManagedCredential"`);
    // A migration that invented a digest would look like working provisioning
    // while authenticating nothing — 1.6's tokens are encrypted, not hashed,
    // so no correct digest is derivable here at all.
    expect(rows[0].n).toBe(0);
  }, PG_TIMEOUT_MS);

  it("keeps 0184's sentinel owner rather than inventing a real user", async () => {
    await seedLegacy([
      { id: "sp_sealed", providerId: "okta-sealed", organizationId: "org_b", userId: SENTINEL },
    ]);

    await runMigration();

    const { rows } = await pool.query(`SELECT "createdBy" FROM "scimManagedConnection"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe(SENTINEL);
  }, PG_TIMEOUT_MS);

  it("gives an org-scoped provider with NO owner the sentinel, since createdBy is NOT NULL", async () => {
    // 1.7's `createdBy` is NOT NULL where 1.6's `userId` was nullable. The
    // honest fill is the reserved non-existent owner — never a live user id.
    await seedLegacy([
      { id: "sp_noowner", providerId: "okta-noowner", organizationId: "org_c", userId: null },
    ]);

    await runMigration();

    const { rows } = await pool.query(`SELECT "createdBy" FROM "scimManagedConnection"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe(SENTINEL);
  }, PG_TIMEOUT_MS);

  it("does NOT carry personal (org-less) providers — they have no provisioning domain", async () => {
    // The negative that matters. These are the rows the advisory was about.
    await seedLegacy([
      { id: "sp_personal", providerId: "personal-1", organizationId: null, userId: SENTINEL },
      { id: "sp_org", providerId: "okta-prod", organizationId: "org_a", userId: "usr_admin" },
    ]);

    await runMigration();

    const { rows } = await pool.query(`SELECT "connectionId" FROM "scimManagedConnection"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].connectionId).toBe("okta-prod");
  }, PG_TIMEOUT_MS);

  it("is idempotent — a re-run carries nothing twice", async () => {
    await seedLegacy([
      { id: "sp_1", providerId: "okta-prod", organizationId: "org_a", userId: "usr_admin" },
    ]);

    await runMigration();
    await runMigration();
    await runMigration();

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "scimManagedConnection"`);
    expect(rows[0].n).toBe(1);
  }, PG_TIMEOUT_MS);

  it("leaves a connection an admin already re-created by hand untouched", async () => {
    await seedLegacy([
      { id: "sp_1", providerId: "okta-prod", organizationId: "org_a", userId: "usr_admin" },
    ]);
    // Same connectionId, but created properly through the admin route: real
    // owner, its own request id. The migration must not clobber it.
    await pool.query(
      `INSERT INTO "scimManagedConnection"
         (id, "creationRequestId", "connectionId", "provisioningDomainId", status, revision, "createdAt", "createdBy")
       VALUES ('mc_manual', 'req_manual', 'okta-prod', 'org_a', 'active', 3, now(), 'usr_real')`,
    );

    await runMigration();

    const { rows } = await pool.query(
      `SELECT "createdBy", revision, "creationRequestId" FROM "scimManagedConnection"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe("usr_real");
    expect(rows[0].revision).toBe(3);
    expect(rows[0].creationRequestId).toBe("req_manual");
  }, PG_TIMEOUT_MS);

  it("no-ops when scimProvider is absent (1.6 SCIM never enabled)", async () => {
    await pool.query(`DROP TABLE IF EXISTS "scimProvider"`);
    await expect(runMigration()).resolves.toBeDefined();
  }, PG_TIMEOUT_MS);

  it("no-ops when scimManagedConnection is absent (1.7 SCIM not enabled)", async () => {
    // A deploy that once ran 1.6 SCIM and has since turned EE off. Erroring
    // here would make its migrations un-runnable entirely.
    await seedLegacy([
      { id: "sp_1", providerId: "okta-prod", organizationId: "org_a", userId: "usr_admin" },
    ]);
    await pool.query(`DROP TABLE IF EXISTS "scimManagedConnection"`);
    await expect(runMigration()).resolves.toBeDefined();
  }, PG_TIMEOUT_MS);
});
