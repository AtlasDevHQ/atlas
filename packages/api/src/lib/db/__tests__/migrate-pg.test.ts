import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";

// Real-Postgres migration smoke. Skips cleanly when TEST_DATABASE_URL
// is unset so local dev that hasn't run `bun run db:up` is unaffected.
//
// CI provides Postgres via a service container in the api-tests job
// and exports `TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`.
// Each test runs against a unique per-test schema so concurrent shards
// don't collide; migrations are scoped to that schema via search_path.
//
// What this catches that mock-based tests can't:
//   - SQL semantic errors at plan time (the 0054 outage was
//     `subquery uses ungrouped column "outer_pc.org_id" from outer query`,
//     a deterministic plan-time error mock pools never see).
//   - Migration ordering bugs where one migration depends on a previous
//     migration's effects.
//   - CHECK / UNIQUE / FK constraint violations on the bootstrap data.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// Per-test timeout — the full migration set is 50+ statements, and shared
// CI runners can take 6-10s for the end-to-end run vs ~2s on local hardware.
// 5s (bun-test default) was causing intermittent failures on shard 4 (#2229).
const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("migrate-pg (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `boot_smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    // Listener must register BEFORE the first query so every connection
    // (including the one that runs the upcoming CREATE SCHEMA) sets
    // search_path to the scratch schema. CREATE SCHEMA itself ignores
    // search_path — it creates the named schema directly — so the
    // chicken-and-egg of "SET search_path to a not-yet-created schema"
    // is harmless: Postgres falls back to `public` for that one
    // statement, the schema gets created, and every subsequent query
    // on that connection lands in the scratch schema.
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        // Surface the failure — silently falling back to `public` would
        // pollute the shared CI Postgres and mask the real cause.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`migrate-pg: SET search_path failed on new connection: ${message}`);
      });
    });
    // Per-test schema so concurrent shards / re-runs don't collide.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it("runs every migration end-to-end against a real Postgres", async () => {
    // Better-Auth-dependent migrations get skipped (those assume
    // `user` / `session` / `organization` already exist). The skip
    // list comes from `internal.ts` so a future migration that
    // references a Better Auth table without being added to
    // MANAGED_AUTH_MIGRATIONS fails this test loudly.
    const count = await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Every non-skipped migration applied. Asserting the count is
    // non-zero is enough — if any migration failed `runMigrations`
    // throws, and the test fails with the underlying SQL error
    // attached. The exact count drifts as new migrations land, so we
    // don't pin it.
    expect(count).toBeGreaterThan(0);
  }, PG_TEST_TIMEOUT_MS);

  it("is idempotent — re-running the migration set is a no-op", async () => {
    // Migrations are recorded in `__atlas_migrations` so a second
    // call should apply zero new migrations. Anything else means a
    // migration is missing the IF EXISTS / IF NOT EXISTS guards
    // documented in CLAUDE.md.
    const count = await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    expect(count).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // #2184 — audit_log.auth_mode CHECK constraint. Inserts that pass
  // the canonical AuthMode tuple succeed; an insert with an unknown
  // mode rejects with PostgreSQL error code 23514 (check_violation),
  // which is the failure mode the DB-side guard is meant to catch.
  it("rejects non-canonical audit_log.auth_mode with 23514", async () => {
    // Sanity: a canonical value writes cleanly.
    await pool.query(
      `INSERT INTO audit_log (auth_mode, sql, duration_ms, success)
       VALUES ('managed', 'SELECT 1', 0, true)`,
    );

    // The drift case from #2182 — literal 'mcp' written by a regression.
    await expect(
      pool.query(
        `INSERT INTO audit_log (auth_mode, sql, duration_ms, success)
         VALUES ('mcp', 'SELECT 1', 0, true)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }, PG_TEST_TIMEOUT_MS);

  // #2173 — workspace_model_config.chk_model_provider_key CHECK constraint
  // is the DB-layer enforcement of "non-gateway must have a key". If this
  // silently drops in a future migration, the BYOT contract breaks at the
  // DB layer with no signal.
  it("workspace_model_config: gateway provider accepts NULL api_key_encrypted", async () => {
    const orgId = `org-gateway-platform-${Date.now()}`;
    await pool.query(
      `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted)
       VALUES ($1, 'gateway', 'anthropic/claude-opus-4.6', NULL)`,
      [orgId],
    );
    const { rows } = await pool.query<{ api_key_encrypted: string | null }>(
      `SELECT api_key_encrypted FROM workspace_model_config WHERE org_id = $1`,
      [orgId],
    );
    expect(rows[0]?.api_key_encrypted).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_model_config: non-gateway provider with NULL api_key_encrypted rejects with 23514", async () => {
    const orgId = `org-anthropic-noKey-${Date.now()}`;
    await expect(
      pool.query(
        `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted)
         VALUES ($1, 'anthropic', 'claude-opus-4-6', NULL)`,
        [orgId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_model_config: chk_model_provider accepts 'gateway' as a provider value", async () => {
    // Regression guard: 0056 drops and replaces chk_model_provider. If the
    // replacement doesn't carry 'gateway' through, this insert fails with
    // the old four-value CHECK.
    const orgId = `org-gateway-byot-${Date.now()}`;
    await pool.query(
      `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted)
       VALUES ($1, 'gateway', 'openai/gpt-4o', 'enc:v1:iv:tag:ciphertext')`,
      [orgId],
    );
    const { rows } = await pool.query<{ provider: string }>(
      `SELECT provider FROM workspace_model_config WHERE org_id = $1`,
      [orgId],
    );
    expect(rows[0]?.provider).toBe("gateway");
  }, PG_TEST_TIMEOUT_MS);

  // 0057 — bedrock provider + chk_model_provider_region. The CHECK is
  // the DB-layer enforcement that bedrock rows always carry a region;
  // the route-layer guards exist but a future bypass would leak through
  // to the AI Layer if this silently drops.
  it("workspace_model_config: chk_model_provider accepts 'bedrock'", async () => {
    const orgId = `org-bedrock-${Date.now()}`;
    await pool.query(
      `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted, bedrock_region)
       VALUES ($1, 'bedrock', 'anthropic.claude-opus-4-v1:0', 'enc:v1:iv:tag:ciphertext', 'us-east-1')`,
      [orgId],
    );
    const { rows } = await pool.query<{ provider: string; bedrock_region: string }>(
      `SELECT provider, bedrock_region FROM workspace_model_config WHERE org_id = $1`,
      [orgId],
    );
    expect(rows[0]?.provider).toBe("bedrock");
    expect(rows[0]?.bedrock_region).toBe("us-east-1");
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_model_config: bedrock with NULL bedrock_region rejects with 23514", async () => {
    const orgId = `org-bedrock-noRegion-${Date.now()}`;
    await expect(
      pool.query(
        `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted, bedrock_region)
         VALUES ($1, 'bedrock', 'anthropic.claude-opus-4-v1:0', 'enc:v1:iv:tag:ciphertext', NULL)`,
        [orgId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }, PG_TEST_TIMEOUT_MS);

  // 0059 — chk_model_status whitelist. A future write that tries to
  // store a third status value (e.g. "retired") must fail at the DB
  // boundary so the modelStatus discriminated-union assumption holds.
  it("workspace_model_config: model_status outside ('healthy','deprecated') rejects with 23514", async () => {
    const orgId = `org-bad-status-${Date.now()}`;
    await expect(
      pool.query(
        `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted, model_status)
         VALUES ($1, 'anthropic', 'claude-opus-4-6', 'enc:v1:iv:tag:ciphertext', 'retired')`,
        [orgId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_model_config: model_status defaults to 'healthy' on insert", async () => {
    const orgId = `org-default-status-${Date.now()}`;
    await pool.query(
      `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted)
       VALUES ($1, 'anthropic', 'claude-opus-4-6', 'enc:v1:iv:tag:ciphertext')`,
      [orgId],
    );
    const { rows } = await pool.query<{ model_status: string }>(
      `SELECT model_status FROM workspace_model_config WHERE org_id = $1`,
      [orgId],
    );
    expect(rows[0]?.model_status).toBe("healthy");
  }, PG_TEST_TIMEOUT_MS);

  // 0062 — connection groups. The migration creates `connection_groups`,
  // adds a nullable `connections.group_id`, and backfills 1:1 so every
  // existing connection lands in a single-member group named after itself.
  // What this set of assertions guards against: a future migration that
  // tightens group_id to NOT NULL without a backfill, breaking boot for
  // any org that already has connection rows — the same failure mode that
  // a prior migration introduced when it added a column to a unique index
  // without backfilling the column first.
  it("connection_groups: table exists with composite PK (id, org_id)", async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'connection_groups'
         AND table_schema = current_schema()
       ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r] as const));
    expect(byName.id?.data_type).toBe("text");
    expect(byName.id?.is_nullable).toBe("NO");
    expect(byName.org_id?.data_type).toBe("text");
    expect(byName.org_id?.is_nullable).toBe("NO");
    expect(byName.name?.data_type).toBe("text");
    expect(byName.name?.is_nullable).toBe("NO");
  }, PG_TEST_TIMEOUT_MS);

  it("connections.group_id: column exists and is nullable during transition", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'connections'
         AND column_name = 'group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // Nullable so legacy single-connection orgs that came up before 0062
    // ran (or that have pre-migration content shapes) keep booting; non-
    // null is enforced by the API for newly-created connections.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("connection_groups: 1:1 backfill creates one group per existing connection", async () => {
    const orgId = `org-backfill-${Date.now()}`;
    // Insert two connections pre-grouping (group_id NULL) — mimics rows
    // that existed before 0062 ran in a real upgrade.
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', NULL),
              ($3, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', NULL)`,
      [`conn-a-${Date.now()}`, orgId, `conn-b-${Date.now()}`],
    );
    // Re-run the backfill block (same SQL the migration uses). Idempotent:
    // ON CONFLICT keeps existing rows, the UPDATE clause only touches
    // rows still missing group_id.
    await pool.query(
      `WITH source AS (
         SELECT id, org_id FROM connections WHERE org_id = $1 AND group_id IS NULL
       )
       INSERT INTO connection_groups (id, org_id, name)
       SELECT 'g_' || id, org_id, id FROM source
       ON CONFLICT (id, org_id) DO NOTHING`,
      [orgId],
    );
    await pool.query(
      `UPDATE connections SET group_id = 'g_' || id
       WHERE org_id = $1 AND group_id IS NULL`,
      [orgId],
    );

    const groupRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM connection_groups WHERE org_id = $1`,
      [orgId],
    );
    expect(groupRows.rows[0]?.count).toBe("2");

    const ungrouped = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM connections WHERE org_id = $1 AND group_id IS NULL`,
      [orgId],
    );
    expect(ungrouped.rows[0]?.count).toBe("0");
  }, PG_TEST_TIMEOUT_MS);

  it("connection_groups: unique constraint blocks duplicate names per org", async () => {
    const orgId = `org-dup-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [`g-first-${Date.now()}`, orgId],
    );
    // 23505 = unique_violation. The constraint is per-org so the same
    // name in a different org is fine.
    await expect(
      pool.query(
        `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
        [`g-second-${Date.now()}`, orgId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);

  it("connections.group_id: FK to (group_id, org_id) blocks cross-org membership", async () => {
    const orgA = `org-a-${Date.now()}`;
    const orgB = `org-b-${Date.now()}`;
    const groupId = `g-isolation-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'shared')`,
      [groupId, orgA],
    );
    // 23503 = foreign_key_violation. Pointing org B's connection at org A's
    // group must fail at the DB layer — composite FK guarantees groups never
    // leak across orgs even if the API layer is bypassed.
    await expect(
      pool.query(
        `INSERT INTO connections (id, url, type, org_id, status, group_id)
         VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
        [`conn-leak-${Date.now()}`, orgB, groupId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  }, PG_TEST_TIMEOUT_MS);

  it("connections.group_id: deleting a non-empty group is rejected with 23503", async () => {
    const orgId = `org-restrict-${Date.now()}`;
    const groupId = `g-tmp-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'temp')`,
      [groupId, orgId],
    );
    const connId = `conn-restrict-${Date.now()}`;
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    // ON DELETE RESTRICT: dropping a group with members fails loudly at
    // the DB layer (23503 = foreign_key_violation). The route-layer
    // DELETE handler maps the same case to a typed 409 with a member
    // count up-front; this assertion guards the last-resort defence.
    await expect(
      pool.query(
        `DELETE FROM connection_groups WHERE id = $1 AND org_id = $2`,
        [groupId, orgId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    // Emptying the group lets the delete proceed.
    await pool.query(
      `UPDATE connections SET group_id = NULL WHERE id = $1 AND org_id = $2`,
      [connId, orgId],
    );
    await pool.query(
      `DELETE FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(rows.length).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // 0063 — semantic_entities.connection_group_id. Adds the group-scoped
  // natural key the multi-environment semantic layer (#2336 / #2340) lives
  // on. The three partial unique indexes from 0028 are dropped and recreated
  // keyed on `(org_id, entity_type, name, COALESCE(connection_group_id,
  // '__default__'))` per status.
  //
  // What this guards against:
  //   - A future schema evolution that re-introduces the 0028 class of bug
  //     (missing-column-in-unique-index) — the regression test explicitly
  //     inserts two entities with the same (org_id, name) but different
  //     entity_type and asserts both can coexist post-migration.
  //   - A future migration that flips connection_group_id to NOT NULL
  //     without a backfill — the existing legacy/demo entities rely on
  //     NULL being a valid value while the connection-id column still
  //     dual-writes during the transition.
  //   - The dual-write contract (#2340) — backfill is required: every
  //     row that had a non-null connection_id must end up with the
  //     corresponding connection_group_id resolved through the 0062 1:1
  //     mapping (g_<connId>).
  it("semantic_entities.connection_group_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'semantic_entities'
         AND column_name = 'connection_group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // Nullable: legacy demo entities at org_id='__global__' carry
    // connection_id=NULL → connection_group_id=NULL too. The COALESCE
    // sentinel in the partial unique indexes handles this; flipping
    // to NOT NULL would orphan the demo entities at boot.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: partial unique indexes are keyed on connection_group_id", async () => {
    // The three partial unique indexes from 0028 are dropped and recreated
    // by 0063 to key on `connection_group_id` rather than `connection_id`.
    // pg_indexes.indexdef reflects the post-CREATE expression, so we can
    // assert the new keying without parsing pg_index.indkey.
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'semantic_entities'
         AND indexname IN (
           'uq_semantic_entity_published',
           'uq_semantic_entity_draft',
           'uq_semantic_entity_tombstone'
         )
       ORDER BY indexname`,
    );
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // Group-keyed: the index includes COALESCE(connection_group_id, ...).
      // `pg_indexes.indexdef` is the reconstructed `CREATE INDEX` and
      // Postgres normalises bare string literals to include an explicit
      // `::text` cast in expression indexes — so the literal we wrote as
      // `'__default__'` comes back as `'__default__'::text`. The
      // optional non-capturing group accepts either form so a future
      // PG-version output flip doesn't silently break this guard.
      expect(row.indexdef).toMatch(/COALESCE\(connection_group_id, '__default__'(?:::text)?\)/i);
      // 0028 prevention: entity_type must be in the key. The 0028 incident
      // was the 0024/0025 indexes losing entity_type from the partial
      // unique key, breaking same-name-different-type entities.
      expect(row.indexdef).toMatch(/entity_type/i);
      // The legacy `connection_id` column must NOT appear in the new
      // index definition — drift between drop+create would leave the
      // old index live and the new one silently absent. Same `::text`
      // optional suffix as above.
      expect(row.indexdef).not.toMatch(/COALESCE\(connection_id, '__default__'(?:::text)?\)/i);
    }
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: 0028 prevention — same (org_id, name) with different entity_type can coexist", async () => {
    // The explicit acceptance criterion of #2340: re-asserts the 0028
    // invariant against the new group-keyed indexes. Before 0028,
    // 'accounts' as both an 'entity' row and a 'metric' row for the
    // same org+scope tripped the partial unique constraint and crashed
    // boot in two prod regions. Any future migration that recreates
    // these indexes without `entity_type` in the key must fail loudly
    // here.
    const orgId = `org-0028-guard-${Date.now()}`;
    const groupId = `g-0028-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'guard')`,
      [groupId, orgId],
    );
    // Two entities sharing org_id + name + connection_group_id but
    // differing on entity_type. Both must insert without 23505.
    await pool.query(
      `INSERT INTO semantic_entities
         (org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status)
       VALUES ($1, 'entity', 'accounts', 'table: accounts', NULL, $2, 'published'),
              ($1, 'metric', 'accounts', 'table: accounts', NULL, $2, 'published')`,
      [orgId, groupId],
    );
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM semantic_entities WHERE org_id = $1 AND name = 'accounts'`,
      [orgId],
    );
    expect(rows[0]?.count).toBe("2");

    // And the new index still enforces uniqueness when entity_type matches:
    // attempting a second published 'entity'/'accounts' row in the same
    // group fails with 23505 = unique_violation.
    await expect(
      pool.query(
        `INSERT INTO semantic_entities
           (org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status)
         VALUES ($1, 'entity', 'accounts', 'table: accounts (dup)', NULL, $2, 'published')`,
        [orgId, groupId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // Pre-migration entities have `connection_id` set but no
    // `connection_group_id`. 0063 backfills by joining `connections`,
    // so every row with a known connection lands on `g_<connId>` (the
    // group_id 0062 created for the 1:1 backfill).
    const orgId = `org-backfill-se-${Date.now()}`;
    const connId = `conn-back-${Date.now()}`;
    const groupId = `g_${connId}`;
    // Seed: connection + its 1:1 group (mirrors what 0062 did at upgrade).
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, orgId, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    // Insert a row matching the pre-0063 shape: connection_id set,
    // connection_group_id left NULL — same shape an upgrade row would
    // have on the moment 0063 starts running.
    await pool.query(
      `INSERT INTO semantic_entities
         (org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status)
       VALUES ($1, 'entity', 'orders', 'table: orders', $2, NULL, 'published')`,
      [orgId, connId],
    );
    // Re-run the backfill block (same SQL the migration emits). Idempotent:
    // the WHERE clause only touches rows still missing connection_group_id.
    await pool.query(
      `UPDATE semantic_entities se
         SET connection_group_id = c.group_id
         FROM connections c
         WHERE se.org_id = $1
           AND se.connection_id IS NOT NULL
           AND se.connection_group_id IS NULL
           AND c.id = se.connection_id
           AND (c.org_id = se.org_id OR c.org_id = '__global__')`,
      [orgId],
    );
    const { rows } = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM semantic_entities
       WHERE org_id = $1 AND name = 'orders' AND entity_type = 'entity'`,
      [orgId],
    );
    expect(rows[0]?.connection_group_id).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: 0063 dedup CTE collapses pre-merged duplicates so the unique index builds", async () => {
    // Defensive case from the multi-env rollout: admins who pre-merged
    // multiple connections into one group (via #2339's admin UI) before
    // 0063 runs will see N rows for what is logically one entity. The
    // migration's dedup CTE keeps the freshest row per group bucket so
    // the new partial unique indexes can be created without 23505.
    //
    // Test shape: two rows sharing (org_id, entity_type, name, group_id)
    // with different `updated_at` — the older one must end up deleted,
    // the newer one preserved. ROW_NUMBER tie-breaker is `id DESC`.
    const orgId = `org-dedup-${Date.now()}`;
    const groupId = `g-dedup-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );
    // Insert two rows that would have collided before 0063's dedup ran.
    // Both rows pre-date the unique index — we insert them directly to
    // simulate the pre-migration shape (the prod indexes are already
    // group-keyed at this point, but the rows here have unique
    // connection_id values + a placeholder name so we can verify the
    // dedup logic on a post-migration database).
    const newerId = `00000000-0000-0000-0000-000000000001`;
    const olderId = `00000000-0000-0000-0000-000000000002`;
    await pool.query(
      `INSERT INTO semantic_entities
         (id, org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status, updated_at)
       VALUES ($1, $2, 'entity', 'dedup_target', 'newer', 'conn-a', $3, 'published', NOW()),
              ($4, $2, 'entity', 'dedup_target_v2', 'older', 'conn-b', $3, 'published', NOW() - INTERVAL '1 hour')`,
      [newerId, orgId, groupId, olderId],
    );
    // Re-run the dedup block — it should be a no-op when the rows
    // have distinct natural keys (different name), so both survive.
    // This validates the ROW_NUMBER PARTITION shape.
    await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY org_id, entity_type, name, status,
                               COALESCE(connection_group_id, '__default__')
                  ORDER BY updated_at DESC, id DESC
                ) AS rn
         FROM semantic_entities
         WHERE org_id = $1 AND status IN ('published', 'draft', 'draft_delete')
       )
       DELETE FROM semantic_entities se USING ranked r
       WHERE se.id = r.id AND r.rn > 1`,
      [orgId],
    );
    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM semantic_entities WHERE org_id = $1`,
      [orgId],
    );
    expect(after.rows[0]?.count).toBe("2");

    // Drop the unique constraint first — the dedup CTE runs BEFORE the
    // index is created in 0063, so it must work against a non-
    // uniqueness-enforced table. Renaming `olderId` to collide with
    // `newerId` would otherwise fail with 23505 against the live
    // index before the dedup ever fires (the test would error on the
    // UPDATE instead of asserting dedup behavior).
    await pool.query(`DROP INDEX uq_semantic_entity_published`);
    // Now collide the two on the same name + group — force the dedup
    // to fire. Rename the older row to match the newer one. Without
    // the dedup CTE, the next CREATE UNIQUE INDEX would fail with
    // 23505; here we assert the CTE picks the right winner first.
    await pool.query(
      `UPDATE semantic_entities SET name = 'dedup_target' WHERE id = $1`,
      [olderId],
    );
    await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY org_id, entity_type, name, status,
                               COALESCE(connection_group_id, '__default__')
                  ORDER BY updated_at DESC, id DESC
                ) AS rn
         FROM semantic_entities
         WHERE org_id = $1 AND status IN ('published', 'draft', 'draft_delete')
       )
       DELETE FROM semantic_entities se USING ranked r
       WHERE se.id = r.id AND r.rn > 1`,
      [orgId],
    );
    const survivors = await pool.query<{ id: string }>(
      `SELECT id FROM semantic_entities WHERE org_id = $1`,
      [orgId],
    );
    // Newer row (freshest updated_at) wins; older row is gone.
    expect(survivors.rows.length).toBe(1);
    expect(survivors.rows[0]?.id).toBe(newerId);

    // Restore the unique index so subsequent tests in the same schema
    // see the production shape.
    await pool.query(
      `CREATE UNIQUE INDEX uq_semantic_entity_published
        ON semantic_entities (org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
        WHERE status = 'published'`,
    );
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: two connections in the same group cannot duplicate the same entity", async () => {
    // Group-scoped uniqueness: a multi-member group has ONE entity row
    // per (entity_type, name) — not N per member. Attempting a second
    // published 'entity'/'orders' row keyed on the same group_id fails
    // with 23505 even when callers think they're "for a different
    // connection." This is the structural promise of #2340 from the
    // PRD: "operators see one entity, one PII classification, one
    // dashboard card."
    const orgId = `org-group-dup-${Date.now()}`;
    const groupId = `g-group-dup-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );
    // First insert — succeeds.
    await pool.query(
      `INSERT INTO semantic_entities
         (org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status)
       VALUES ($1, 'entity', 'orders', 'table: orders', 'us-int', $2, 'published')`,
      [orgId, groupId],
    );
    // Second insert with same (org_id, entity_type, name, connection_group_id)
    // — must fail with 23505 even though connection_id differs.
    await expect(
      pool.query(
        `INSERT INTO semantic_entities
           (org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status)
         VALUES ($1, 'entity', 'orders', 'table: orders', 'eu', $2, 'published')`,
        [orgId, groupId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);

  // 0064 — pii_column_classifications.connection_group_id. Mirrors the 0063
  // shape on the PII table: the natural key flips from `connection_id` to
  // `connection_group_id`, the legacy NOT NULL DEFAULT 'default' on
  // `connection_id` drops, and the unique index is recreated keyed on the
  // group. The PRD assumption (replicas inside a group share schema, so a
  // column's PII classification is the same across all group members) is
  // pinned by the group-reassignment test below: moving a connection
  // between groups MUST NOT carry classifications with it — the row stays
  // attached to the originating group, and the new group inherits its own
  // independent classification set.
  it("pii_column_classifications.connection_group_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'pii_column_classifications'
         AND column_name = 'connection_group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // Nullable: legacy rows may carry connection_id values that no longer
    // resolve to a live connection (orphaned classifications from deleted
    // connections). Those rows backfill to NULL and live in the COALESCE
    // sentinel bucket alongside other un-scoped rows. Flipping to NOT
    // NULL would orphan them at boot.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("pii_column_classifications.connection_id: legacy NOT NULL DEFAULT 'default' dropped", async () => {
    // 0064 drops the `NOT NULL DEFAULT 'default'` so callers don't get
    // silently bucketed into a `'default'` sentinel they never asked for.
    // The group is the natural key now; connection_id is dual-write for
    // the transitional SDK and goes away in #2346.
    const { rows } = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'pii_column_classifications'
         AND column_name = 'connection_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.is_nullable).toBe("YES");
    expect(rows[0]?.column_default).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  it("pii_column_classifications: unique index is keyed on connection_group_id, not connection_id", async () => {
    // The baseline inline UNIQUE constraint auto-names to the 63-byte
    // truncated `...column_name_connec` name, not `...co_key`; 0064 must
    // drop that constraint before creating the group-keyed index.
    const legacyConstraintName = "pii_column_classifications_org_id_table_name_column_name_connec";
    const legacy = await pool.query<{ conname: string; constraintdef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS constraintdef
       FROM pg_constraint
       WHERE conrelid = 'pii_column_classifications'::regclass
         AND conname = $1`,
      [legacyConstraintName],
    );
    expect(legacy.rows).toEqual([]);

    // The old connection-keyed uniqueness is dropped and recreated by
    // 0064 to key on `connection_group_id`. `pg_indexes.indexdef`
    // reflects the post-CREATE expression so we can assert the new
    // keying without parsing pg_index.indkey.
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'pii_column_classifications'
         AND indexname = 'pii_column_classifications_unique'`,
    );
    expect(rows.length).toBe(1);
    // Group-keyed: COALESCE(connection_group_id, '__default__'). The
    // `::text` optional suffix matches PG's expression-index reconstruction.
    expect(rows[0]?.indexdef).toMatch(/COALESCE\(connection_group_id, '__default__'(?:::text)?\)/i);
    // The legacy `connection_id` column MUST NOT appear in the new
    // index — drift between drop+create would leave the old index live
    // and the new one silently absent.
    expect(rows[0]?.indexdef).not.toMatch(/connection_id/i);
  }, PG_TEST_TIMEOUT_MS);

  it("pii_column_classifications: backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // Pre-migration classifications have `connection_id` set but no
    // `connection_group_id`. 0064 backfills by joining `connections`, so
    // every row with a known connection lands on `g_<connId>` (the group
    // 0062 created for the 1:1 backfill).
    const orgId = `org-backfill-pii-${Date.now()}`;
    const connId = `conn-back-pii-${Date.now()}`;
    const groupId = `g_${connId}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, orgId, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    // Pre-0064 shape: connection_id set, connection_group_id NULL.
    await pool.query(
      `INSERT INTO pii_column_classifications
         (org_id, table_name, column_name, connection_id, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', $2, NULL, 'email', 'high', 'partial')`,
      [orgId, connId],
    );
    // Re-run the backfill block (same SQL the migration emits). Idempotent
    // — the WHERE clause only touches rows still missing connection_group_id.
    await pool.query(
      `UPDATE pii_column_classifications pc
         SET connection_group_id = c.group_id
         FROM connections c
         WHERE pc.org_id = $1
           AND pc.connection_id IS NOT NULL
           AND pc.connection_group_id IS NULL
           AND c.id = pc.connection_id
           AND (c.org_id = pc.org_id OR c.org_id = '__global__')`,
      [orgId],
    );
    const { rows } = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM pii_column_classifications
       WHERE org_id = $1 AND table_name = 'users' AND column_name = 'email'`,
      [orgId],
    );
    expect(rows[0]?.connection_group_id).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  it("pii_column_classifications: two connections in the same group cannot duplicate the same classification", async () => {
    // Group-scoped uniqueness — the PRD invariant for #2341. A multi-
    // member group ("us-int + eu + apac = one logical 'prod'") sees one
    // classification per (table, column). Attempting a second row keyed
    // on the same group with a different connection_id must fail with
    // 23505. This is the assumption the prompt asks us to lock in: same
    // column = same PII across group members.
    const orgId = `org-pii-group-dup-${Date.now()}`;
    const groupId = `g-pii-group-dup-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );
    await pool.query(
      `INSERT INTO pii_column_classifications
         (org_id, table_name, column_name, connection_id, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', 'us-int', $2, 'email', 'high', 'partial')`,
      [orgId, groupId],
    );
    await expect(
      pool.query(
        `INSERT INTO pii_column_classifications
           (org_id, table_name, column_name, connection_id, connection_group_id, category, confidence, masking_strategy)
         VALUES ($1, 'users', 'email', 'eu', $2, 'email', 'high', 'partial')`,
        [orgId, groupId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);

  it("pii_column_classifications: group reassignment keeps classifications with the originating group", async () => {
    // PRD #2336 acceptance criterion (from issue #2341): moving a
    // connection between groups must NOT carry classifications with it
    // — the row stays attached to the originating group, and the new
    // group inherits its own independent classification set.
    //
    // Why: PII classifications live on the GROUP, not the connection.
    // Reassigning `us-int` from group `prod` to group `staging` is a
    // governance event ("we're treating this replica as staging now");
    // the staging admins decide their own PII posture from scratch.
    // Auto-migrating the prod classifications would silently relax
    // staging's posture to match prod's, which is exactly the failure
    // mode the PRD calls out.
    const orgId = `org-reassign-${Date.now()}`;
    const prodGroup = `g-prod-${Date.now()}`;
    const stagingGroup = `g-staging-${Date.now()}`;
    const connId = `conn-reassign-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod'), ($3, $2, 'staging')`,
      [prodGroup, orgId, stagingGroup],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, prodGroup],
    );
    // Classify `users.email` on the prod group.
    await pool.query(
      `INSERT INTO pii_column_classifications
         (org_id, table_name, column_name, connection_id, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', $2, $3, 'email', 'high', 'partial')`,
      [orgId, connId, prodGroup],
    );
    // Reassign the connection to staging. The classification's
    // connection_group_id must NOT follow — it stays on prod.
    await pool.query(
      `UPDATE connections SET group_id = $1 WHERE id = $2 AND org_id = $3`,
      [stagingGroup, connId, orgId],
    );
    const prodRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pii_column_classifications
       WHERE org_id = $1 AND connection_group_id = $2`,
      [orgId, prodGroup],
    );
    expect(prodRows.rows[0]?.count).toBe("1");
    const stagingRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pii_column_classifications
       WHERE org_id = $1 AND connection_group_id = $2`,
      [orgId, stagingGroup],
    );
    expect(stagingRows.rows[0]?.count).toBe("0");

    // Staging admins can now classify the same column independently —
    // no 23505, because the row is keyed on the staging group.
    await pool.query(
      `INSERT INTO pii_column_classifications
         (org_id, table_name, column_name, connection_id, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', $2, $3, 'email', 'low', 'redact')`,
      [orgId, connId, stagingGroup],
    );
    const stagingAfter = await pool.query<{ masking_strategy: string }>(
      `SELECT masking_strategy FROM pii_column_classifications
       WHERE org_id = $1 AND connection_group_id = $2 AND table_name = 'users' AND column_name = 'email'`,
      [orgId, stagingGroup],
    );
    expect(stagingAfter.rows[0]?.masking_strategy).toBe("redact");
  }, PG_TEST_TIMEOUT_MS);

  it("pii_column_classifications: 0064 dedup CTE collapses pre-merged duplicates so the unique index builds", async () => {
    // Defensive case from the multi-env rollout: admins who pre-merged
    // multiple connections into one group (via #2339's admin UI) before
    // 0064 runs will see N classification rows for what is logically
    // one (org, table, column, group) entry. The migration's dedup CTE
    // keeps the freshest row per group bucket so the new unique index
    // can be created without 23505. Mirrors the 0063 dedup shape.
    const orgId = `org-pii-dedup-${Date.now()}`;
    const groupId = `g-pii-dedup-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );
    // Insert two pre-merged rows differing only on connection_id. Both
    // currently coexist under the live group-keyed index because they
    // target distinct column names (so we can seed without collision),
    // then we rename to force the dedup to fire.
    const newerId = `00000000-0000-0000-0000-aaaa00000001`;
    const olderId = `00000000-0000-0000-0000-aaaa00000002`;
    await pool.query(
      `INSERT INTO pii_column_classifications
         (id, org_id, table_name, column_name, connection_id, connection_group_id, category, confidence, masking_strategy, updated_at)
       VALUES ($1, $2, 'users', 'email_v1', 'conn-a', $3, 'email', 'high', 'partial', NOW()),
              ($4, $2, 'users', 'email_v2', 'conn-b', $3, 'email', 'high', 'partial', NOW() - INTERVAL '1 hour')`,
      [newerId, orgId, groupId, olderId],
    );
    // Drop the unique index so we can force a name collision and then
    // re-run the dedup CTE. (The dedup CTE runs BEFORE the new index is
    // built in the production migration; this test mirrors that order.)
    await pool.query(`DROP INDEX pii_column_classifications_unique`);
    await pool.query(
      `UPDATE pii_column_classifications SET column_name = 'email_v1' WHERE id = $1`,
      [olderId],
    );
    await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY org_id, table_name, column_name,
                               COALESCE(connection_group_id, '__default__')
                  ORDER BY updated_at DESC, id DESC
                ) AS rn
         FROM pii_column_classifications
         WHERE org_id = $1
       )
       DELETE FROM pii_column_classifications pc USING ranked r
       WHERE pc.id = r.id AND r.rn > 1`,
      [orgId],
    );
    const survivors = await pool.query<{ id: string }>(
      `SELECT id FROM pii_column_classifications WHERE org_id = $1`,
      [orgId],
    );
    expect(survivors.rows.length).toBe(1);
    expect(survivors.rows[0]?.id).toBe(newerId);

    // Restore the unique index so subsequent tests see production shape.
    await pool.query(
      `CREATE UNIQUE INDEX pii_column_classifications_unique
        ON pii_column_classifications (org_id, table_name, column_name, COALESCE(connection_group_id, '__default__'))`,
    );
  }, PG_TEST_TIMEOUT_MS);
});
