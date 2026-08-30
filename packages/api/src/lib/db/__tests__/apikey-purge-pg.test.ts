/**
 * Real-Postgres falsifier for the `apikey` half of the GDPR purge (#5525).
 *
 * The gap this pins, quoted from the issue: the 1.7 `apikey` table "declares
 * **no foreign key at all** — the owning user id sits in `referenceId` (a plain
 * string) and the workspace binding sits in `metadata.orgId` (JSON text)". So
 * neither arm of `hardDeleteWorkspace` reached it: the orphaned-user arm had no
 * statement and no cascade to inherit, and the workspace arm had nothing to
 * scope by. An erased user's key rows — name, prefix, hashed secret, and the
 * minting member's RLS claims — survived their own account, and keys minted
 * against a purged workspace kept naming an org that no longer existed.
 *
 * Why real Postgres: the whole value of this fix is in two predicates and in
 * the fact that neither can be inherited. A mocked query layer evaluates
 * neither, and — the sharper reason — it cannot show that the ABSENCE of an FK
 * is what makes both statements load-bearing. This fixture deliberately gives
 * `apikey` no foreign key, exactly as the plugin's schema does, so gutting
 * either statement leaves rows standing rather than being covered by a cascade
 * the way `session` and `account` are (see hard-delete-purge-pg.test.ts's note
 * on that split — there, deleting the statement still passes).
 *
 * The load-bearing assertions are the NEGATIVE ones, in scim-purge-pg's style,
 * and each names the arm it falsifies:
 *
 *   - `ak-org-shared` — bound to the purged workspace, owner SURVIVES in
 *     another workspace. THE #5525 acceptance criterion that asked for a
 *     recorded decision: it is deleted, and only the workspace arm can do it.
 *     Without a surviving owner, "the key is gone" is satisfied by the orphan
 *     arm alone and the decision is untested.
 *   - `ak-stale-orphan` — owned by the ERASED user but naming a DIFFERENT
 *     workspace, the binding left behind when a membership was removed. Only
 *     the orphan arm reaches it. Without this row, "the key is gone" is
 *     satisfied by the workspace arm alone and the orphan statement is
 *     deletable with this suite still green.
 *   - `ak-nb-shared` — the multi-workspace control the issue names: a shared
 *     user's key bound to the OTHER workspace must survive, or the purge is an
 *     unscoped delete that passes every "zero rows remain" check while
 *     destroying another tenant's CI credential.
 *   - `ak-garbage-shared` — metadata that is not JSON. Not an edge case for
 *     tidiness: it is the falsifier for a SQL-side `metadata::jsonb` predicate,
 *     which raises 22P02 on this row and takes the entire erasure transaction
 *     down with it. The purge must complete, and this row must survive.
 *   - `ak-double-org` — the plugin's own doubly-stringified legacy shape.
 *
 * `apikey` is stood up here rather than by a migration because it is
 * plugin-owned: better-auth's schema-diff creates it at boot, never the Atlas
 * runner. `hardDeleteWorkspace` probes it for that reason, but with `scim*`'s
 * semantics INVERTED: `apiKey()` is unconditional in `buildPlugins()`, so an
 * absent relation is region drift (skipped, `complete: false`) rather than the
 * "never enabled" state a missing scim catalog means. This fixture stands the
 * table up, so the probe's present arm is what runs here; the absent arm is
 * `tableExists`'s own, shared with every other probed relation.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  hardDeleteWorkspace,
  _resetPool,
  type InternalPool,
  type HardDeleteResult,
} from "@atlas/api/lib/db/internal";
import { buildApiKeyMetadata } from "@atlas/api/lib/auth/api-key-metadata";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const PG_TIMEOUT_MS = 120_000;

const ORG = "org-apikey-purge";
/** Seeded identically, never purged — the blast-radius control. */
const NEIGHBOUR = "org-apikey-neighbour";
/** Member of ORG only — orphaned by the purge. */
const USER_ORPHAN = "user-apikey-orphan";
/**
 * Member of BOTH workspaces. THE case: their ORG-bound key must go while their
 * NEIGHBOUR-bound key stands, and the user row itself survives — so the orphan
 * arm cannot be what removes the first one.
 */
const USER_SHARED = "user-apikey-shared";
/** Member of NEIGHBOUR only — untouched by ORG's purge, key and all. */
const USER_NEIGHBOUR = "user-apikey-neighbour";

/** Minimal Better Auth spine — same shape the other purge falsifiers bootstrap. */
const BETTER_AUTH_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    role TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "providerId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "organization" (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "member" (
    id TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "invitation" (
    id TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
    email TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * The @better-auth/api-key 1.7 table, with the columns the purge touches plus
 * the personal-data columns the issue names, so their deletion is a deletion of
 * something.
 *
 * ⚠️ NO FOREIGN KEY, on `referenceId` or anywhere else. That is not a shortcut:
 * it is the schema the plugin declares and the entire substance of #5525. An FK
 * here would make the orphan-arm statement redundant and this suite would go
 * green with it deleted.
 */
const APIKEY_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS "apikey" (
    id TEXT PRIMARY KEY,
    name TEXT,
    start TEXT,
    key TEXT,
    "referenceId" TEXT NOT NULL,
    metadata TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/** What the plugin stores: one JSON.stringify of the metadata object. */
const stored = (orgId: string, claims?: Record<string, unknown>): string =>
  JSON.stringify(buildApiKeyMetadata({ orgId, role: "member", ...(claims ? { claims } : {}) }));

describeIfPg("apikey GDPR purge falsifier (real Postgres, #5525)", () => {
  let pool: Pool;
  const schemaName = `apikey_purge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let result: HardDeleteResult;

  /**
   * Sorted in JS, not by `ORDER BY id`: the ids are hyphenated, and a database
   * collation that treats punctuation as secondary would order them differently
   * from the literal array the last assertion compares against.
   */
  const keyIds = async (): Promise<string[]> => {
    const r = await pool.query<{ id: string }>(`SELECT id FROM "apikey"`);
    return r.rows.map((row) => row.id).toSorted();
  };

  beforeAll(async () => {
    // Scratch schema baked into the connection string, and pgcrypto forced into
    // `public` first — both for the reasons hard-delete-purge-pg.test.ts
    // documents at length.
    const setupPool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await setupPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await setupPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`);
    await setupPool.end();

    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 4,
      options: `-c search_path="${schemaName}",public`,
    });
    await pool.query(BETTER_AUTH_BOOTSTRAP_SQL);
    await pool.query(APIKEY_BOOTSTRAP_SQL);
    await runMigrations(pool);

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool);

    for (const workspaceId of [ORG, NEIGHBOUR]) {
      await pool.query(`INSERT INTO "organization" (id, name, slug) VALUES ($1, $1, $1)`, [
        workspaceId,
      ]);
    }
    await pool.query(`UPDATE "organization" SET workspace_status = 'deleted' WHERE id = $1`, [ORG]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, 'orphan@apikey.test')`, [USER_ORPHAN]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, 'shared@apikey.test')`, [USER_SHARED]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, 'nb@apikey.test')`, [USER_NEIGHBOUR]);
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role) VALUES
         ('m-orphan', $1, $2, 'owner'),
         ('m-shared-org', $1, $3, 'member')`,
      [ORG, USER_ORPHAN, USER_SHARED],
    );
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role) VALUES
         ('m-shared-nb', $1, $2, 'member'),
         ('m-nb-only', $1, $3, 'owner')`,
      [NEIGHBOUR, USER_SHARED, USER_NEIGHBOUR],
    );

    await pool.query(
      `INSERT INTO "apikey" (id, name, start, key, "referenceId", metadata) VALUES
         ($1,  'orphan ci',      'atk_aaa', 'hash-a', $10, $2),
         ($3,  'shared org ci',  'atk_bbb', 'hash-b', $11, $4),
         ($5,  'shared nb ci',   'atk_ccc', 'hash-c', $11, $6),
         ($7,  'stale binding',  'atk_ddd', 'hash-d', $10, $6),
         ($8,  'legacy double',  'atk_eee', 'hash-e', $11, $9),
         ('ak-unmarked-org',  'unmarked',  'atk_fff', 'hash-f', $11, $12),
         ('ak-garbage-shared','not json',  'atk_ggg', 'hash-g', $11, 'not json at all'),
         ('ak-null-shared',   'no meta',   'atk_hhh', 'hash-h', $11, NULL),
         ('ak-nb-only',       'nb only ci','atk_iii', 'hash-i', $13, $6)`,
      [
        "ak-org-orphan",
        stored(ORG),
        "ak-org-shared",
        // The claim bag is the point: `metadata.claims` holds the minting
        // member's RLS claim VALUES, which describe the customer's own tenancy.
        stored(ORG, { tenant_id: "acme" }),
        "ak-nb-shared",
        stored(NEIGHBOUR),
        "ak-stale-orphan",
        "ak-double-org",
        // The plugin's legacy double-stringified write.
        JSON.stringify(stored(ORG)),
        USER_ORPHAN,
        USER_SHARED,
        // A bag naming the org WITHOUT the workspace marker: over-inclusive by
        // design on an erasure path (see apiKeyMetadataNamesOrg).
        JSON.stringify({ orgId: ORG }),
        USER_NEIGHBOUR,
      ],
    );

    result = await hardDeleteWorkspace(ORG);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {
      // intentionally ignored: teardown of a throwaway schema
    });
    await pool?.end();
  });

  it("removes the MULTI-WORKSPACE user's key for the purged workspace — while sparing the user and their other key", async () => {
    // THE #5525 decision, and the arm only the workspace predicate can reach:
    // the owner is still a member of NEIGHBOUR, so no orphan statement and no
    // cascade touches this row.
    const user = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [USER_SHARED]);
    expect(user.rows.length, "the shared user must survive the purge").toBe(1);
    expect(await keyIds(), "the shared user's PURGED-workspace key (hashed secret + RLS claims) survived")
      .not.toContain("ak-org-shared");
    expect(await keyIds(), "the shared user's OTHER-workspace key must NOT be touched")
      .toContain("ak-nb-shared");
  });

  it("removes an ERASED user's key even when it names a different workspace", async () => {
    // The orphan arm's own case. `ak-stale-orphan` is bound to NEIGHBOUR — the
    // binding a removed membership leaves behind — so the workspace predicate
    // does not match it, and there is no FK to cascade from the deleted user
    // row. If this survives, a user-linked credential outlives the account it
    // was erased with, which is the class #5515's registry exists to surface.
    const user = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [USER_ORPHAN]);
    expect(user.rows.length, "the orphaned user must be erased").toBe(0);
    const ids = await keyIds();
    expect(ids, "the erased user's stale-binding key survived their own account").not.toContain(
      "ak-stale-orphan",
    );
    expect(ids, "the erased user's own workspace key survived").not.toContain("ak-org-orphan");
  });

  it("reads the plugin's legacy double-stringified metadata, and an unmarked bag", async () => {
    const ids = await keyIds();
    expect(ids, "a doubly-stringified metadata bag hid a purged-workspace binding").not.toContain(
      "ak-double-org",
    );
    expect(ids, "a bag naming this org without the workspace marker must still be erased").not.toContain(
      "ak-unmarked-org",
    );
  });

  it("completes the purge over a row whose metadata is NOT JSON, and spares that row", async () => {
    // The falsifier for a SQL-side `metadata::jsonb` predicate: it raises 22P02
    // here and rolls back the whole erasure. `complete` is the boolean an
    // operator attaches to a DPA erasure record, so the purge reaching this
    // point at all is half the assertion.
    expect(result.skippedTables, "apikey reported as skipped work").not.toContain("apikey");
    const ids = await keyIds();
    expect(ids, "a key with unreadable metadata names no workspace and must not be guessed at").toContain(
      "ak-garbage-shared",
    );
    expect(ids, "a key with NULL metadata names no workspace").toContain("ak-null-shared");
  });

  it("does not touch the neighbouring workspace's keys (blast radius)", async () => {
    // An unscoped `DELETE FROM apikey` satisfies every "the key is gone" check
    // above while destroying every other tenant's CI credentials.
    const ids = await keyIds();
    for (const survivor of ["ak-nb-shared", "ak-nb-only"]) {
      expect(ids, `${survivor} belongs to the NEIGHBOUR and must survive ORG's purge`).toContain(
        survivor,
      );
    }
    const nbUser = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [USER_NEIGHBOUR]);
    expect(nbUser.rows.length, "a NEIGHBOUR-only user must survive ORG's purge").toBe(1);
  });

  it("leaves NO apikey row naming the purged workspace or owned by an erased user (the sweep)", async () => {
    // The issue's acceptance criteria stated as one query over what remains:
    // the endpoint answers "All data has been irreversibly removed", which is
    // false while either predicate still matches a row.
    const residue = await pool.query<{ id: string }>(
      `SELECT id FROM "apikey"
        WHERE "referenceId" = $1
           OR (metadata IS NOT NULL AND position($2 in metadata) > 0)`,
      [USER_ORPHAN, ORG],
    );
    expect(
      residue.rows.map((r) => r.id),
      "apikey rows referencing the purged workspace or its erased user survived",
    ).toEqual([]);
  });

  it("reports the EXACT count, summing both arms", () => {
    // Exact, not merely non-zero: 4 rows name ORG in their metadata
    // (ak-org-orphan, ak-org-shared, ak-double-org, ak-unmarked-org) and the
    // orphan arm then takes the 1 remaining key owned by the erased user
    // (ak-stale-orphan). A count of 4 means the orphan arm's rows were dropped
    // from the receipt; a count of 1 means the workspace arm's were.
    expect(result.counts.apikey).toBe(5);
    // Pinned alongside it because the orphan arm's reach is derived from this:
    // if the purge orphaned a different number of users, the 5 above would be
    // right arithmetic over the wrong set.
    expect(result.counts.orphanedUsers).toBe(1);
  });

  it("leaves exactly the four keys that name neither the workspace nor an erased user", async () => {
    expect(await keyIds()).toEqual([
      "ak-garbage-shared",
      "ak-nb-only",
      "ak-nb-shared",
      "ak-null-shared",
    ]);
  });
});
