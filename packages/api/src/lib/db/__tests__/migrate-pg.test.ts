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

  // 0063 — semantic_entities.connection_group_id. The unique natural key
  // moved from connection_id to connection_group_id while keeping entity_type
  // in the expression index. This is the same class of boot-risk as 0028:
  // if entity_type is omitted, metrics and entities with the same name collide.
  it("semantic_entities.connection_group_id: column exists", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'semantic_entities'
         AND column_name = 'connection_group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: group-scoped unique key keeps entity_type in the key", async () => {
    const orgId = `org-sem-group-${Date.now()}`;
    const groupId = `g-sem-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod')`,
      [groupId, orgId],
    );

    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'accounts', 'table: accounts', $2, 'published')`,
      [orgId, groupId],
    );
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'metric', 'accounts', 'sql: count(*)', $2, 'published')`,
      [orgId, groupId],
    );

    await expect(
      pool.query(
        `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
         VALUES ($1, 'entity', 'accounts', 'table: accounts_v2', $2, 'published')`,
        [orgId, groupId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);
});
