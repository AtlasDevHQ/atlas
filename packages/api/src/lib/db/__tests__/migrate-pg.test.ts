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

  // 0067 — conversations.connection_group_id. Adds the *content scope*
  // column the chat-routing slice (#2345) lives on while keeping the
  // existing `conversations.connection_id` as the *execution target*.
  // What this set of assertions guards against:
  //   - A future migration that flips `connection_group_id` to NOT NULL
  //     without a backfill — legacy conversations without a connection
  //     (rare, pre-0034 self-hosted shapes) must keep booting.
  //   - The backfill contract — every conversation whose `connection_id`
  //     points at a known connection must end up with the corresponding
  //     `connection_group_id` resolved through 0062's 1:1 mapping.
  it("conversations.connection_group_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'conversations'
         AND column_name = 'connection_group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // Nullable: pre-0034 self-hosted shapes that never had a
    // connection_id keep booting, and a workspace with zero groups
    // (legacy single-connection deploy) doesn't gain a NOT NULL stamp
    // on every chat row.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("conversations: 0067 backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // Pre-0067 conversations have `connection_id` set but no
    // `connection_group_id`. The migration backfills by joining
    // `connections`, so every row with a known connection lands on
    // `g_<connId>` (the group_id 0062 created for the 1:1 backfill).
    const orgId = `org-conv-backfill-${Date.now()}`;
    const connId = `conn-cb-${Date.now()}`;
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
    // Insert a conversation matching the pre-0067 shape: connection_id
    // set, connection_group_id left NULL — same shape an upgrade row
    // would have on the moment 0067 starts running.
    const convRow = await pool.query<{ id: string }>(
      `INSERT INTO conversations (user_id, title, surface, connection_id, connection_group_id, org_id)
       VALUES ($1, $2, 'web', $3, NULL, $4)
       RETURNING id`,
      [`user-cb-${Date.now()}`, "Test backfill", connId, orgId],
    );
    const conversationId = convRow.rows[0]?.id;
    expect(conversationId).toBeDefined();

    // Re-run the backfill block (same SQL the migration emits).
    // Idempotent: the WHERE clause only touches rows still missing
    // connection_group_id.
    await pool.query(
      `UPDATE conversations c
         SET connection_group_id = conn.group_id
         FROM connections conn
         WHERE c.org_id = $1
           AND c.connection_id IS NOT NULL
           AND c.connection_group_id IS NULL
           AND conn.id = c.connection_id
           AND (conn.org_id = c.org_id OR conn.org_id = '__global__')`,
      [orgId],
    );
    const { rows } = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.connection_group_id).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  it("conversations: connection_id and connection_group_id can hold independent values (per-turn override shape)", async () => {
    // The slice's core invariant: a conversation can pin its content
    // scope to a multi-member "prod" group while its execution target
    // points at a specific replica. This test inserts a row with the
    // two columns deliberately divergent and asserts no DB-layer guard
    // collapses them.
    const orgId = `org-conv-decouple-${Date.now()}`;
    const groupId = `g-prod-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );
    const userId = `user-decouple-${Date.now()}`;
    // connection_id points at "us-int"; connection_group_id at the
    // multi-member "prod" group. The pair must coexist.
    await pool.query(
      `INSERT INTO conversations (user_id, title, connection_id, connection_group_id, org_id)
       VALUES ($1, 'decoupled', 'us-int', $2, $3)`,
      [userId, groupId, orgId],
    );
    const { rows } = await pool.query<{ connection_id: string; connection_group_id: string }>(
      `SELECT connection_id, connection_group_id FROM conversations WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]?.connection_id).toBe("us-int");
    expect(rows[0]?.connection_group_id).toBe(groupId);
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

  // 0065 — group-scoped approval queue. The migration adds
  // `approval_queue.connection_group_id` (FK to connection_groups), drops
  // the vestigial `connection_id NOT NULL DEFAULT 'default'`, and back-
  // fills via the 0062 1:1 connection→group map. What this set of
  // assertions guards against:
  //   - A future migration that re-introduces NOT NULL on connection_id,
  //     breaking the audit-only nullable shape post-#2344.
  //   - A future migration that drops connection_group_id without an
  //     equivalent group-scope replacement, regressing the "approve once
  //     per group" semantics.
  //   - The backfill drifting: every existing row that had a valid
  //     connection_id must end up with the corresponding
  //     connection_group_id resolved through 0062's `g_<connId>` map.
  it("approval_queue.connection_group_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'approval_queue'
         AND column_name = 'connection_group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // Nullable: legacy pre-#2344 rows and callers without a group
    // context (the agent loop's identityMissing path stays NULL too)
    // must keep booting; the lookup uses a COALESCE sentinel to match
    // the NULL case.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("approval_queue.connection_id: column is nullable post-#2344 (no NOT NULL DEFAULT)", async () => {
    // The pre-#2344 schema had `connection_id NOT NULL DEFAULT 'default'`,
    // which silently rewrote unstamped inserts to the string 'default'.
    // 0065 drops both — the column is audit-only, the lookup keys on
    // connection_group_id. A future migration that re-tightens this
    // would force every caller back through the 'default' drift shape.
    const { rows } = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'approval_queue'
         AND column_name = 'connection_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.is_nullable).toBe("YES");
    expect(rows[0]?.column_default).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  it("approval_queue: backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // Pre-migration approval rows have `connection_id` set but no
    // `connection_group_id`. 0065 backfills by joining `connections`,
    // so every row with a known connection lands on `g_<connId>` (the
    // group_id 0062 created for the 1:1 backfill).
    const orgId = `org-approval-backfill-${Date.now()}`;
    const connId = `conn-approval-${Date.now()}`;
    const groupId = `g_${connId}`;
    // Seed the 1:1 group + connection that 0062 would have produced.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, orgId, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    // Seed an approval rule the approval_queue row can reference (the
    // queue has no rule_id FK, but using a real UUID keeps the row
    // shape consistent with production inserts).
    const ruleRow = await pool.query<{ id: string }>(
      `INSERT INTO approval_rules (org_id, name, rule_type, pattern, threshold, enabled)
       VALUES ($1, 'Backfill rule', 'table', 'orders', NULL, true)
       RETURNING id`,
      [orgId],
    );
    const ruleId = ruleRow.rows[0].id;
    // Insert an approval row matching the pre-0065 shape: connection_id
    // set, connection_group_id left NULL — same shape an upgrade row
    // would have on the moment 0065 starts running.
    await pool.query(
      `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, query_sql, connection_id, connection_group_id)
       VALUES ($1, $2, 'Backfill rule', 'user-backfill', 'SELECT * FROM orders', $3, NULL)`,
      [orgId, ruleId, connId],
    );
    // Re-run the backfill block (same SQL the migration uses).
    // Idempotent: the WHERE clause only touches rows still missing
    // connection_group_id.
    await pool.query(
      `UPDATE approval_queue aq
         SET connection_group_id = c.group_id
         FROM connections c
         WHERE aq.org_id = $1
           AND aq.connection_id IS NOT NULL
           AND aq.connection_group_id IS NULL
           AND c.id = aq.connection_id
           AND (c.org_id = aq.org_id OR c.org_id = '__global__')`,
      [orgId],
    );
    const { rows } = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM approval_queue
       WHERE org_id = $1 AND requester_id = 'user-backfill'`,
      [orgId],
    );
    expect(rows[0]?.connection_group_id).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  it("approval_queue: global connection backfill mirrors group into tenant before FK use", async () => {
    // Demo / built-in connections are stored under `__global__`, but
    // approval rows are tenant-scoped. 0065 mirrors the global group row
    // into the tenant before writing approval_queue.connection_group_id so
    // the composite FK can remain tenant-local.
    const orgId = `org-approval-global-${Date.now()}`;
    const connId = `conn-global-approval-${Date.now()}`;
    const groupId = `g_${connId}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [groupId, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', '__global__', 'published', $2)`,
      [connId, groupId],
    );
    const ruleRow = await pool.query<{ id: string }>(
      `INSERT INTO approval_rules (org_id, name, rule_type, pattern, threshold, enabled)
       VALUES ($1, 'Global backfill rule', 'table', 'orders', NULL, true)
       RETURNING id`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, query_sql, connection_id, connection_group_id)
       VALUES ($1, $2, 'Global backfill rule', 'user-global-backfill', 'SELECT * FROM orders', $3, NULL)`,
      [orgId, ruleRow.rows[0].id, connId],
    );

    await pool.query(
      `WITH global_approval_groups AS (
         SELECT DISTINCT
                COALESCE(aq.connection_group_id, c.group_id) AS group_id,
                aq.org_id AS tenant_org_id,
                ('__global__:' || g.id) AS name
           FROM approval_queue aq
           JOIN connections c
             ON c.id = aq.connection_id
            AND c.org_id = '__global__'
           JOIN connection_groups g
             ON g.id = c.group_id
            AND g.org_id = '__global__'
          WHERE aq.org_id = $1
            AND aq.org_id <> '__global__'
            AND COALESCE(aq.connection_group_id, c.group_id) IS NOT NULL
       )
       INSERT INTO connection_groups (id, org_id, name)
       SELECT group_id, tenant_org_id, name
         FROM global_approval_groups
       ON CONFLICT (id, org_id) DO NOTHING`,
      [orgId],
    );
    await pool.query(
      `UPDATE approval_queue aq
         SET connection_group_id = c.group_id
         FROM connections c
         WHERE aq.org_id = $1
           AND aq.connection_id IS NOT NULL
           AND aq.connection_group_id IS NULL
           AND c.id = aq.connection_id
           AND (c.org_id = aq.org_id OR c.org_id = '__global__')`,
      [orgId],
    );

    const { rows } = await pool.query<{ connection_group_id: string | null; mirrored: string | null }>(
      `SELECT aq.connection_group_id,
              (SELECT g.id FROM connection_groups g WHERE g.id = aq.connection_group_id AND g.org_id = aq.org_id) AS mirrored
         FROM approval_queue aq
        WHERE aq.org_id = $1 AND aq.requester_id = 'user-global-backfill'`,
      [orgId],
    );
    expect(rows[0]?.connection_group_id).toBe(groupId);
    expect(rows[0]?.mirrored).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  it("approval_queue.connection_group_id: composite FK blocks cross-org membership", async () => {
    // Same shape as `connections.group_id` in 0062: the composite FK
    // (connection_group_id, org_id) → connection_groups (id, org_id)
    // makes it impossible for an approval row in org B to reference a
    // group that lives in org A.
    const orgA = `org-approval-fk-a-${Date.now()}`;
    const orgB = `org-approval-fk-b-${Date.now()}`;
    const groupId = `g-approval-fk-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'shared')`,
      [groupId, orgA],
    );
    const ruleRow = await pool.query<{ id: string }>(
      `INSERT INTO approval_rules (org_id, name, rule_type, pattern, threshold, enabled)
       VALUES ($1, 'Cross-org rule', 'table', 'orders', NULL, true)
       RETURNING id`,
      [orgB],
    );
    // 23503 = foreign_key_violation. Pointing org B's approval row at
    // org A's group must fail loudly at the DB layer.
    await expect(
      pool.query(
        `INSERT INTO approval_queue
           (org_id, rule_id, rule_name, requester_id, query_sql, connection_group_id)
         VALUES ($1, $2, 'Cross-org rule', 'user-1', 'SELECT 1', $3)`,
        [orgB, ruleRow.rows[0].id, groupId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  }, PG_TEST_TIMEOUT_MS);

  it("approval_queue.connection_group_id: deleting a referenced group is rejected with 23503", async () => {
    // ON DELETE RESTRICT on the FK is the last-resort defence against
    // a group teardown that would orphan live approval rows. The route
    // handler in `admin-connection-groups.ts` already rejects non-
    // empty groups with a 409; this guards the path where a caller
    // bypasses the handler (raw SQL or future call site).
    const orgId = `org-approval-restrict-${Date.now()}`;
    const groupId = `g-approval-restrict-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'temp')`,
      [groupId, orgId],
    );
    const ruleRow = await pool.query<{ id: string }>(
      `INSERT INTO approval_rules (org_id, name, rule_type, pattern, threshold, enabled)
       VALUES ($1, 'Restrict rule', 'table', 'orders', NULL, true)
       RETURNING id`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, query_sql, connection_group_id)
       VALUES ($1, $2, 'Restrict rule', 'user-1', 'SELECT 1', $3)`,
      [orgId, ruleRow.rows[0].id, groupId],
    );
    // 23503: dropping a group with a live approval row pointing at it
    // must fail.
    await expect(
      pool.query(
        `DELETE FROM connection_groups WHERE id = $1 AND org_id = $2`,
        [groupId, orgId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    // Removing the approval row's group reference lets the delete
    // proceed — proves the FK isn't blocking on phantom data.
    await pool.query(
      `UPDATE approval_queue SET connection_group_id = NULL WHERE org_id = $1 AND requester_id = 'user-1'`,
      [orgId],
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

  it("approval_queue: idx_approval_queue_group is the partial-index on approved-only rows", async () => {
    // The new lookup-path index is partial (status = 'approved') so it
    // stays small even on workspaces with a deep historical queue.
    // A future "drop the partial predicate" change would explode the
    // index size and burn IO on every hasApprovedRequest call.
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'approval_queue'
         AND indexname = 'idx_approval_queue_group'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.indexdef).toMatch(/status = 'approved'/i);
    expect(rows[0]?.indexdef).toMatch(/connection_group_id/i);
  }, PG_TEST_TIMEOUT_MS);


  // 0066 — Group-scoped dashboard cards (PRD #2336, issue #2342).
  //
  //  - `dashboard_cards.connection_group_id` is the new scope column; it's
  //    additive and nullable for transitional dual-write — existing
  //    `connection_id` rows keep working until callers migrate.
  //  - `connection_groups.primary_connection_id` is a nullable, composite
  //    FK pointing at `(connections.id, connections.org_id)` so a primary
  //    cannot point at a connection in another org. The FK action is
  //    `ON DELETE SET NULL` — removing a connection from the org should
  //    silently clear its "primary" flag, not block the delete.
  //  - Backfill: any pre-0066 card with `connection_id` set gets the
  //    corresponding `connection_group_id` resolved through 0062's 1:1
  //    `g_<connId>` mapping.
  it("dashboard_cards.connection_group_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'dashboard_cards'
         AND column_name = 'connection_group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // Nullable during transition — legacy cards keep their `connection_id`
    // until the deprecation slice (#2347) removes the column entirely.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("connection_groups.primary_connection_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'connection_groups'
         AND column_name = 'primary_connection_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    // NULL = "fall back to first member ordered by (created_at, id)" —
    // the resolver in lib/dashboards-group-resolve.ts handles both cases.
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("connection_groups.primary_connection_id: composite FK rejects cross-org primaries with 23503", async () => {
    // The primary must live in the same org as the group. A composite FK
    // on `(primary_connection_id, org_id) → connections(id, org_id)` is
    // the DB-layer guarantee against the otherwise-tempting "let admins
    // pick any connection id" bug class — same logic 0062 uses for the
    // FK on `connections.group_id`.
    const orgA = `org-a-pri-${Date.now()}`;
    const orgB = `org-b-pri-${Date.now()}`;
    const groupBId = `g-pri-${Date.now()}`;
    const connAId = `conn-cross-${Date.now()}`;
    // Group lives in org B; connection lives in org A. The connection
    // exists, but its (id, org_id) tuple is in a different org — the
    // composite FK must reject the UPDATE.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'cross-org')`,
      [groupBId, orgB],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published')`,
      [connAId, orgA],
    );
    await expect(
      pool.query(
        `UPDATE connection_groups SET primary_connection_id = $1 WHERE id = $2 AND org_id = $3`,
        [connAId, groupBId, orgB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  }, PG_TEST_TIMEOUT_MS);

  it("connection_groups.primary_connection_id: SET NULL on connection delete", async () => {
    // Removing a connection drops it from the group AND clears the
    // primary pointer in the same transaction. Without SET NULL the
    // RESTRICT default from the FK shape would block any delete that
    // hit a primary-pinned connection — that's a worse default than
    // "silently demote and require admin to repin".
    const orgId = `org-setnull-${Date.now()}`;
    const groupId = `g-setnull-${Date.now()}`;
    const connId = `conn-primary-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    await pool.query(
      `UPDATE connection_groups SET primary_connection_id = $1 WHERE id = $2 AND org_id = $3`,
      [connId, groupId, orgId],
    );
    // First clear the membership so 0062's ON DELETE RESTRICT FK on
    // `connections.group_id` doesn't block the connection delete.
    await pool.query(
      `UPDATE connections SET group_id = NULL WHERE id = $1 AND org_id = $2`,
      [connId, orgId],
    );
    await pool.query(
      `DELETE FROM connections WHERE id = $1 AND org_id = $2`,
      [connId, orgId],
    );
    const { rows } = await pool.query<{ primary_connection_id: string | null }>(
      `SELECT primary_connection_id FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(rows[0]?.primary_connection_id).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  it("dashboard_cards: backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // Pre-0066 cards reference a `connection_id` directly. The migration
    // backfills `connection_group_id` to the group `g_<connId>` that 0062
    // created. Same backfill shape as 0063 — keeps the dual-write contract
    // in lockstep while the deprecation slice (#2347) is still pending.
    const orgId = `org-card-backfill-${Date.now()}`;
    const connId = `conn-card-${Date.now()}`;
    const groupId = `g_${connId}`;
    const dashboardOwner = `owner-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, orgId, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    const dashRow = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, $2, 'card-backfill') RETURNING id`,
      [orgId, dashboardOwner],
    );
    const dashboardId = dashRow.rows[0]?.id;
    // Pre-0066 card shape: connection_id set, connection_group_id NULL.
    await pool.query(
      `INSERT INTO dashboard_cards (dashboard_id, title, sql, connection_id, connection_group_id)
       VALUES ($1, 'card', 'SELECT 1', $2, NULL)`,
      [dashboardId, connId],
    );
    // Re-run the backfill block (same SQL the migration emits).
    await pool.query(
      `UPDATE dashboard_cards dc
         SET connection_group_id = c.group_id
         FROM connections c, dashboards d
         WHERE dc.dashboard_id = d.id
           AND d.org_id = $1
           AND dc.connection_id IS NOT NULL
           AND dc.connection_group_id IS NULL
           AND c.id = dc.connection_id
           AND (c.org_id = d.org_id OR c.org_id = '__global__')`,
      [orgId],
    );
    const { rows } = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM dashboard_cards WHERE dashboard_id = $1`,
      [dashboardId],
    );
    expect(rows[0]?.connection_group_id).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  // 0068 — scheduled_tasks.connection_group_id. The scheduler is now scoped
  // to a connection group while retaining connection_id for the #2346
  // compatibility window.
  it("scheduled_tasks.connection_group_id: column exists and is nullable", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_name = 'scheduled_tasks'
          AND column_name = 'connection_group_id'`,
    );

    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("scheduled_tasks.connection_group_id: composite FK blocks cross-org membership", async () => {
    const groupId = `g_sched_fk_${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ($1, 'org-a', $2)`,
      [groupId, `${groupId}-name`],
    );

    await expect(
      pool.query(
        `INSERT INTO scheduled_tasks
           (owner_id, org_id, name, question, cron_expression, delivery_channel, recipients, connection_group_id)
         VALUES
           ('owner-1', 'org-b', 'Bad group', 'Revenue?', '0 9 * * *', 'email', '[]'::jsonb, $1)`,
        [groupId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  }, PG_TEST_TIMEOUT_MS);
});
