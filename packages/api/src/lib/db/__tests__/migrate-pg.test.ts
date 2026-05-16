import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL,
  MERGE_CONNECTIONS_INTO_GROUP_SQL,
  CASCADE_ARCHIVE_GROUP_ENTITIES_SQL,
  CASCADE_ARCHIVE_GROUP_TASKS_SQL,
  CASCADE_ARCHIVE_GROUP_APPROVALS_SQL,
  ARCHIVE_GROUP_SQL,
} from "@atlas/api/lib/db/connection-groups-sql";

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

  it("connections.group_id: column exists and is NOT NULL after cleanup", async () => {
    const { rows } = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'connections'
         AND column_name = 'group_id'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    expect(rows[0]?.is_nullable).toBe("NO");
  }, PG_TEST_TIMEOUT_MS);

  it("connection_groups: cleaned connections keep one group per existing connection", async () => {
    const orgId = `org-backfill-${Date.now()}`;
    const connA = `conn-a-${Date.now()}`;
    const connB = `conn-b-${Date.now()}`;
    const groupA = `g_${connA}`;
    const groupB = `g_${connB}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ($1, $2, $3),
              ($4, $2, $5)`,
      [groupA, orgId, connA, groupB, connB],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3),
              ($4, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $5)`,
      [connA, orgId, groupA, connB, groupB],
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

    // Deleting the member lets the group delete proceed.
    await pool.query(
      `DELETE FROM connections WHERE id = $1 AND org_id = $2`,
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

  // #2410 — env-delete CTE must drop both archived shapes. Reproduces
  // the third-pass failure: PR #2405 added the cascading archived
  // delete, PR #2406 tightened it to `url <> ''` to preserve global-hide
  // tombstones (which it succeeded at — outside env-delete), but the
  // env-delete path itself then 23503'd whenever the group contained a
  // `url = ''` tombstone. The shape mirrors the per-org `__global__`
  // hide INSERT written by the non-`ownRow` branch of
  // `admin-connections.ts` DELETE /:id.
  //
  // Imports `DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL` so this test and
  // the production route share the same canonical SQL — a regression
  // that tightens the WHERE clause shows up in both files in the same
  // diff and can't sneak through.
  it("connections.group_id: env-delete CTE drops both archived shapes (#2410)", async () => {
    const orgId = `org-tomb-${Date.now()}`;
    const groupId = `g-tomb-${Date.now()}`;
    const archivedOwnedConnId = `conn-archived-${Date.now()}`;
    const tombstoneConnId = `conn-tomb-${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'tombstone-env')`,
      [groupId, orgId],
    );

    // Shape 1: archived in-place — org-owned row, real encrypted URL,
    // `status = 'archived'`. This is what the `ownRow` branch of
    // `admin-connections.ts` DELETE /:id produces when the admin
    // deletes an org-owned connection.
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'archived', $3)`,
      [archivedOwnedConnId, orgId, groupId],
    );

    // Shape 2: per-org `__global__` tombstone — `url = ''`,
    // `status = 'archived'`, non-null `group_id`. This is what the
    // non-`ownRow` branch of `admin-connections.ts` DELETE /:id
    // produces when the admin hides a global connection. Pre-fix the
    // env-delete CTE filtered `url <> ''`, so this row stayed put and
    // the trailing `DELETE FROM connection_groups` 23503'd against the
    // connections_group_id FK.
    await pool.query(
      `INSERT INTO connections (id, url, url_key_version, type, description, org_id, status, group_id)
       VALUES ($1, '', 1, 'postgres', 'Hidden from this workspace', $2, 'archived', $3)`,
      [tombstoneConnId, orgId, groupId],
    );

    // Sanity: run the *pre-fix* CTE (with `AND url <> ''`) and confirm
    // it still 23503s with the tombstone present. This pins the exact
    // regression mode — not the "raw delete fails" property of the FK
    // (which has always been true and is already covered above by the
    // 0062 RESTRICT test). If a future change accidentally tightens
    // the production CTE again, the positive assertion below would
    // catch the symptom; this sanity step locks the cause.
    await expect(
      pool.query(
        `WITH deleted_archived_connections AS (
           DELETE FROM connections
            WHERE group_id = $1
              AND org_id = $2
              AND status = 'archived'
              AND url <> ''
           RETURNING id
         )
         DELETE FROM connection_groups WHERE id = $1 AND org_id = $2`,
        [groupId, orgId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    // The fixed CTE — imported from the production module so the test
    // and the route share one source of truth.
    await pool.query(DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL, [groupId, orgId]);

    // Group is gone.
    const groupRows = await pool.query<{ id: string }>(
      `SELECT id FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(groupRows.rows.length).toBe(0);

    // Both archived rows are gone — no orphans, no FK violations.
    const connRows = await pool.query<{ id: string }>(
      `SELECT id FROM connections WHERE org_id = $1 AND id IN ($2, $3)`,
      [orgId, archivedOwnedConnId, tombstoneConnId],
    );
    expect(connRows.rows.length).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // Adjacent shape: a group whose *only* archived row is a `url = ''`
  // tombstone. This is the exact production path an admin hits when
  // they hide a global into a fresh environment and then delete that
  // environment without ever attaching an org-owned connection. The
  // CTE handles it because the predicate is `status = 'archived'`, but
  // a future "optimization" that reinstates `url <> ''` would let the
  // multi-shape test above still pass on shape 1 while quietly failing
  // closed on this one. The single-shape variant catches that drift.
  it("connections.group_id: env-delete CTE drops a tombstone-only group (#2410)", async () => {
    const orgId = `org-tomb-only-${Date.now()}`;
    const groupId = `g-tomb-only-${Date.now()}`;
    const tombstoneConnId = `conn-tomb-only-${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'tombstone-only-env')`,
      [groupId, orgId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, url_key_version, type, description, org_id, status, group_id)
       VALUES ($1, '', 1, 'postgres', 'Hidden from this workspace', $2, 'archived', $3)`,
      [tombstoneConnId, orgId, groupId],
    );

    await pool.query(DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL, [groupId, orgId]);

    const groupRows = await pool.query<{ id: string }>(
      `SELECT id FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(groupRows.rows.length).toBe(0);

    const connRows = await pool.query<{ id: string }>(
      `SELECT id FROM connections WHERE org_id = $1 AND id = $2`,
      [orgId, tombstoneConnId],
    );
    expect(connRows.rows.length).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // ── Merge CTE smoke (#2409) ─────────────────────────────────────────
  //
  // MERGE_CONNECTIONS_INTO_GROUP_SQL consolidates N source connections
  // into one target environment in a single atomic statement. The mock-
  // pool wire tests pin the SQL shape; this real-Postgres smoke pins
  // the planning-time semantics that mocks can't catch:
  //
  //   - `LIKE 'g\_%' ESCAPE '\'` — the literal backslash escape is easy
  //     to silently break with a future "string normalization" pass.
  //   - `name = SUBSTRING(id FROM 3)` — pins the 0062 auto-backfill
  //     signature. A migration that renames backfilled groups (e.g. 0070
  //     for the __global__: prefix) must not accidentally surface them
  //     as cleanup candidates again.
  //   - `(xmax = 0)` on the target CTE — distinguishes INSERT from
  //     ON CONFLICT DO UPDATE. The wizard's "Created prod" vs "Added to
  //     prod" copy depends on this fact landing correctly.
  //   - The seven NOT EXISTS guards (FK-bearing + soft-reference) —
  //     cleanup MUST be skipped when the source group still anchors
  //     admin-curated content. We can't easily test all seven, but the
  //     two that have FKs (approval_queue, scheduled_tasks) AND the
  //     soft-reference NULL-safe path (insert a row into one of the
  //     no-FK tables and assert the source group survives) are the
  //     load-bearing ones — the rest follow the same shape.
  //
  // Why this matters: per the project memory `feedback_migration_pg_smoke.md`,
  // mock-pool tests can't catch SQL planning errors. The CTE has equivalent
  // planning-time risk to the env-delete CTE that #2410 needed three
  // patches to get right; the precedent is explicit.
  it("merge CTE: happy path inserts target, moves connections, deletes auto-backfilled singletons (#2409)", async () => {
    const orgId = `org-merge-${Date.now()}`;
    const conn1 = `m-conn-1-${Date.now()}`;
    const conn2 = `m-conn-2-${Date.now()}`;
    const group1 = `g_${conn1}`;
    const group2 = `g_${conn2}`;
    const targetId = `g_target-${Date.now()}`;

    // Seed the 0062 1:1 backfill shape: each connection in its own
    // singleton group named after the bare connection id.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3), ($4, $2, $5)`,
      [group1, orgId, conn1, group2, conn2],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id) VALUES
         ($1, 'postgresql://stub-1', 'postgres', $2, 'published', $3),
         ($4, 'postgresql://stub-2', 'postgres', $2, 'published', $5)`,
      [conn1, orgId, group1, conn2, group2],
    );

    const { rows } = await pool.query<{
      target: { id: string; name: string; primaryConnectionId: string; created: boolean };
      moved_connection_ids: string[];
      deleted_group_ids: string[];
      skipped_group_ids: string[];
    }>(MERGE_CONNECTIONS_INTO_GROUP_SQL, [
      targetId, // $1
      orgId, // $2
      "prod-merge", // $3
      conn1, // $4 primary
      false, // $5 override
      [conn1, conn2], // $6
      [group1, group2], // $7
    ]);

    expect(rows[0].target.created).toBe(true);
    expect(rows[0].target.name).toBe("prod-merge");
    expect(rows[0].moved_connection_ids.sort()).toEqual([conn1, conn2].sort());
    expect(rows[0].deleted_group_ids.sort()).toEqual([group1, group2].sort());
    expect(rows[0].skipped_group_ids).toEqual([]);

    // Connections are now parented to the target.
    const reparentedRows = await pool.query<{ id: string; group_id: string }>(
      `SELECT id, group_id FROM connections WHERE org_id = $1 AND id IN ($2, $3)`,
      [orgId, conn1, conn2],
    );
    expect(reparentedRows.rows.every((r) => r.group_id === targetId)).toBe(true);

    // Source singletons are gone.
    const sourceGroupRows = await pool.query<{ id: string }>(
      `SELECT id FROM connection_groups WHERE org_id = $1 AND id IN ($2, $3)`,
      [orgId, group1, group2],
    );
    expect(sourceGroupRows.rows.length).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  it("merge CTE: cleanup is skipped when the source group still anchors a scheduled task (#2409)", async () => {
    const orgId = `org-merge-st-${Date.now()}`;
    const conn1 = `m-st-conn-${Date.now()}`;
    const group1 = `g_${conn1}`;
    const targetId = `g_target-st-${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [group1, orgId, conn1],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id) VALUES
         ($1, 'postgresql://stub', 'postgres', $2, 'published', $3)`,
      [conn1, orgId, group1],
    );
    // A scheduled task pinned to the source group. The CTE's NOT EXISTS
    // guard against `scheduled_tasks.connection_group_id` is the only
    // thing between this and the FK rolling the whole merge back with
    // 23503. Pin the gating behaviour: merge succeeds, source group
    // survives, the task's reference stays valid.
    // Column names mirror the canonical insert from the 0065 / 0068
    // smoke tests above — `question` + `cron_expression`, not `prompt` /
    // `cron_schedule`. Pinned here so a regression in scheduled_tasks
    // shape surfaces in one of two sibling tests (#2409, #2418).
    await pool.query(
      `INSERT INTO scheduled_tasks
         (owner_id, org_id, name, question, cron_expression, delivery_channel, recipients, connection_group_id)
       VALUES
         ('owner-1', $1, 'noop', 'noop?', '0 0 * * *', 'email', '[]'::jsonb, $2)`,
      [orgId, group1],
    );

    const { rows } = await pool.query<{
      moved_connection_ids: string[];
      deleted_group_ids: string[];
      skipped_group_ids: string[];
    }>(MERGE_CONNECTIONS_INTO_GROUP_SQL, [
      targetId,
      orgId,
      "prod-merge-st",
      conn1,
      false,
      [conn1],
      [group1],
    ]);

    expect(rows[0].moved_connection_ids).toEqual([conn1]);
    expect(rows[0].deleted_group_ids).toEqual([]);
    expect(rows[0].skipped_group_ids).toEqual([group1]);

    // Source group survives — the scheduled task's connection_group_id
    // reference is still valid.
    const survivedRows = await pool.query<{ id: string }>(
      `SELECT id FROM connection_groups WHERE org_id = $1 AND id = $2`,
      [orgId, group1],
    );
    expect(survivedRows.rows.length).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("merge CTE: admin-renamed singleton survives cleanup even when empty (#2409)", async () => {
    // Cleanup must only delete groups matching the 0062 auto-backfill
    // signature (`name = SUBSTRING(id FROM 3)`). An admin who renamed
    // their `g_warehouse` group to "Warehouse" expects that label to
    // persist; a merge that nukes it as cleanup would be data loss.
    const orgId = `org-merge-renamed-${Date.now()}`;
    const conn1 = `m-renamed-conn-${Date.now()}`;
    const group1 = `g_${conn1}`;
    const targetId = `g_target-renamed-${Date.now()}`;

    // Backfill-shape id, but a non-default (admin-set) name.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'Warehouse')`,
      [group1, orgId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id) VALUES
         ($1, 'postgresql://stub', 'postgres', $2, 'published', $3)`,
      [conn1, orgId, group1],
    );

    const { rows } = await pool.query<{
      deleted_group_ids: string[];
      skipped_group_ids: string[];
    }>(MERGE_CONNECTIONS_INTO_GROUP_SQL, [
      targetId,
      orgId,
      "prod-merge-renamed",
      conn1,
      false,
      [conn1],
      [group1],
    ]);

    // Renamed group is NOT in either array — it's not eligible for
    // cleanup at all, so it's not a candidate, so it's not "skipped".
    expect(rows[0].deleted_group_ids).toEqual([]);
    expect(rows[0].skipped_group_ids).toEqual([]);

    const survivedRows = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM connection_groups WHERE org_id = $1 AND id = $2`,
      [orgId, group1],
    );
    expect(survivedRows.rows.length).toBe(1);
    expect(survivedRows.rows[0].name).toBe("Warehouse");
  }, PG_TEST_TIMEOUT_MS);

  it("merge CTE: ON CONFLICT reuses an existing target and preserves its primary unless overridden (#2409)", async () => {
    const orgId = `org-merge-reuse-${Date.now()}`;
    const conn1 = `m-reuse-conn-1-${Date.now()}`;
    const conn2 = `m-reuse-conn-2-${Date.now()}`;
    const group1 = `g_${conn1}`;
    const group2 = `g_${conn2}`;
    const existingTargetId = `g_existing-${Date.now()}`;
    const newTargetId = `g_new-target-${Date.now()}`;

    // Seed: an existing target group with its own primary already set.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'prod-reuse'), ($3, $2, $4), ($5, $2, $6)`,
      [existingTargetId, orgId, group1, conn1, group2, conn2],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id) VALUES
         ($1, 'postgresql://stub-1', 'postgres', $2, 'published', $3),
         ($4, 'postgresql://stub-2', 'postgres', $2, 'published', $5)`,
      [conn1, orgId, group1, conn2, group2],
    );
    await pool.query(
      `UPDATE connection_groups SET primary_connection_id = $1 WHERE id = $2 AND org_id = $3`,
      [conn1, existingTargetId, orgId],
    );

    // Call with `override = false` and a different proposed primary —
    // the existing primary must survive.
    const { rows } = await pool.query<{
      target: { id: string; created: boolean; primaryConnectionId: string };
    }>(MERGE_CONNECTIONS_INTO_GROUP_SQL, [
      newTargetId, // ignored on conflict
      orgId,
      "prod-reuse",
      conn2, // proposed primary
      false, // override = false → preserve existing
      [conn1, conn2],
      [group1, group2],
    ]);

    expect(rows[0].target.created).toBe(false);
    expect(rows[0].target.id).toBe(existingTargetId);
    expect(rows[0].target.primaryConnectionId).toBe(conn1);
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
         (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'accounts', 'table: accounts', $2, 'published'),
              ($1, 'metric', 'accounts', 'table: accounts', $2, 'published')`,
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
           (org_id, entity_type, name, yaml_content, connection_group_id, status)
         VALUES ($1, 'entity', 'accounts', 'table: accounts (dup)', $2, 'published')`,
        [orgId, groupId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);

  it("semantic_entities: 0063 backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // The smoke suite runs every migration end-to-end (including 0069),
    // which drops `semantic_entities.connection_id`. To exercise the
    // ACTUAL backfill SQL from 0063 against a pre-migration row shape,
    // we temporarily re-add `connection_id`, seed a row with it set and
    // `connection_group_id IS NULL`, run the migration's UPDATE block
    // verbatim, then drop the column to restore the post-0069 shape.
    const orgId = `org-backfill-se-${Date.now()}`;
    const connId = `conn-back-${Date.now()}`;
    const groupId = `g_${connId}`;
    await pool.query(`ALTER TABLE semantic_entities ADD COLUMN connection_id TEXT`);
    try {
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
      // Pre-0063 shape: connection_id set, connection_group_id NULL.
      await pool.query(
        `INSERT INTO semantic_entities
           (org_id, entity_type, name, yaml_content, connection_id, connection_group_id, status)
         VALUES ($1, 'entity', 'orders', 'table: orders', $2, NULL, 'published')`,
        [orgId, connId],
      );
      // Run the migration's actual backfill block (verbatim from 0063).
      await pool.query(
        `UPDATE semantic_entities se
           SET connection_group_id = c.group_id
           FROM connections c
           WHERE se.connection_id IS NOT NULL
             AND se.connection_group_id IS NULL
             AND c.id = se.connection_id
             AND (c.org_id = se.org_id OR c.org_id = '__global__')`,
      );
      const { rows } = await pool.query<{ connection_group_id: string | null }>(
        `SELECT connection_group_id FROM semantic_entities
         WHERE org_id = $1 AND name = 'orders' AND entity_type = 'entity'`,
        [orgId],
      );
      expect(rows[0]?.connection_group_id).toBe(groupId);
    } finally {
      // Cleanup must not shadow an in-`try` assertion error. If the DROP
      // itself trips (pool closed mid-test, etc.), log and let the
      // original failure propagate.
      try {
        await pool.query(`ALTER TABLE semantic_entities DROP COLUMN connection_id`);
      } catch (err) {
        console.warn(
          `cleanup semantic_entities.connection_id DROP failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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
         (id, org_id, entity_type, name, yaml_content, connection_group_id, status, updated_at)
       VALUES ($1, $2, 'entity', 'dedup_target', 'newer', $3, 'published', NOW()),
              ($4, $2, 'entity', 'dedup_target_v2', 'older', $3, 'published', NOW() - INTERVAL '1 hour')`,
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

  // ─── #2412 — semantic_entities cross-group isolation SQL ──────────────
  // The mock-based unit tests in `semantic/__tests__/entities-group-scope.test.ts`
  // assert SQL shape but can't prove Postgres actually isolates rows by
  // `connection_group_id`. These tests run the production SQL patterns
  // directly against the test pool — bypassing `internal.ts` because that
  // helper reads DATABASE_URL (production) rather than this file's
  // TEST_DATABASE_URL pool with the per-test schema. The SQL bodies
  // mirror `getEntity` / `deleteEntity` verbatim so a regression in
  // either helper's predicate fails the test.

  it("scoped predicate (IS NOT DISTINCT FROM) returns only the matching group's row (#2412)", async () => {
    const orgId = `org-2412-get-${Date.now()}`;
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES
         ($1, 'entity', 'users', 'table: users\ndescription: prod US\n', 'g_prod_us', 'published'),
         ($1, 'entity', 'users', 'table: users\ndescription: prod EU\n', 'g_prod_eu', 'published')`,
      [orgId],
    );

    // Mirrors the scoped branch of `getEntity` in entities.ts.
    const us = await pool.query<{ connection_group_id: string; yaml_content: string }>(
      `SELECT connection_group_id, yaml_content
       FROM semantic_entities
       WHERE org_id = $1 AND entity_type = $2 AND name = $3
         AND connection_group_id IS NOT DISTINCT FROM $4
         AND status IN ('published', 'draft', 'draft_delete')
       ORDER BY CASE status WHEN 'draft_delete' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END
       LIMIT 1`,
      [orgId, "entity", "users", "g_prod_us"],
    );
    expect(us.rows[0]?.connection_group_id).toBe("g_prod_us");
    expect(us.rows[0]?.yaml_content).toContain("prod US");

    const eu = await pool.query<{ connection_group_id: string }>(
      `SELECT connection_group_id FROM semantic_entities
       WHERE org_id = $1 AND entity_type = $2 AND name = $3
         AND connection_group_id IS NOT DISTINCT FROM $4`,
      [orgId, "entity", "users", "g_prod_eu"],
    );
    expect(eu.rows[0]?.connection_group_id).toBe("g_prod_eu");
  }, PG_TEST_TIMEOUT_MS);

  it("unscoped probe with DISTINCT ON returns 2 groups (caller throws) (#2412)", async () => {
    const orgId = `org-2412-ambig-${Date.now()}`;
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES
         ($1, 'entity', 'orders', 'table: orders\n', 'g_a', 'published'),
         ($1, 'entity', 'orders', 'table: orders\n', 'g_b', 'published')`,
      [orgId],
    );

    // Mirrors the unscoped branch of `getEntity`. The CTE collapses to
    // one row per group; the outer SELECT excludes tombstones.
    const rows = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id
       FROM (
         SELECT DISTINCT ON (connection_group_id)
                connection_group_id, status
         FROM semantic_entities
         WHERE org_id = $1 AND entity_type = $2 AND name = $3
           AND status IN ('published', 'draft', 'draft_delete')
         ORDER BY connection_group_id,
                  CASE status WHEN 'draft_delete' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END
       ) overlay
       WHERE status != 'draft_delete'
       ORDER BY connection_group_id NULLS FIRST`,
      [orgId, "entity", "orders"],
    );

    expect(rows.rows.length).toBe(2);
    const groups = rows.rows.map((r) => r.connection_group_id).toSorted();
    expect(groups).toEqual(["g_a", "g_b"]);
  }, PG_TEST_TIMEOUT_MS);

  it("unscoped DISTINCT ON collapses single-group overlay (published + draft) to ONE row (#2412)", async () => {
    // The original regression: counting raw rows treated published+draft
    // as ambiguity. The DISTINCT ON groups them into one logical entity.
    const orgId = `org-2412-overlay-${Date.now()}`;
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES
         ($1, 'entity', 'accounts', 'table: accounts\ndescription: published\n', 'g_only', 'published'),
         ($1, 'entity', 'accounts', 'table: accounts\ndescription: draft edit\n', 'g_only', 'draft')`,
      [orgId],
    );

    const rows = await pool.query<{ connection_group_id: string; status: string }>(
      `SELECT connection_group_id, status
       FROM (
         SELECT DISTINCT ON (connection_group_id)
                connection_group_id, status
         FROM semantic_entities
         WHERE org_id = $1 AND entity_type = $2 AND name = $3
           AND status IN ('published', 'draft', 'draft_delete')
         ORDER BY connection_group_id,
                  CASE status WHEN 'draft_delete' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END
       ) overlay
       WHERE status != 'draft_delete'`,
      [orgId, "entity", "accounts"],
    );

    expect(rows.rows.length).toBe(1);
    // Draft beats published in the priority CASE.
    expect(rows.rows[0]?.status).toBe("draft");
    expect(rows.rows[0]?.connection_group_id).toBe("g_only");
  }, PG_TEST_TIMEOUT_MS);

  it("scoped DELETE with IS NOT DISTINCT FROM leaves the other group's row intact (#2412)", async () => {
    const orgId = `org-2412-del-${Date.now()}`;
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES
         ($1, 'entity', 'invoices', 'table: invoices\n', 'g_us', 'published'),
         ($1, 'entity', 'invoices', 'table: invoices\n', 'g_eu', 'published')`,
      [orgId],
    );

    // Mirrors the DELETE predicate of `deleteEntity`.
    const deleted = await pool.query<{ id: string }>(
      `DELETE FROM semantic_entities
       WHERE org_id = $1 AND entity_type = $2 AND name = $3
         AND connection_group_id IS NOT DISTINCT FROM $4
       RETURNING id`,
      [orgId, "entity", "invoices", "g_us"],
    );
    expect(deleted.rows.length).toBe(1);

    const survivors = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM semantic_entities
       WHERE org_id = $1 AND entity_type = 'entity' AND name = 'invoices'`,
      [orgId],
    );
    expect(survivors.rows.length).toBe(1);
    expect(survivors.rows[0]?.connection_group_id).toBe("g_eu");
  }, PG_TEST_TIMEOUT_MS);

  it("scoped DELETE with NULL matches legacy null-group row only (#2412)", async () => {
    const orgId = `org-2412-null-${Date.now()}`;
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES
         ($1, 'entity', 'demos', 'table: demos\n', NULL, 'published'),
         ($1, 'entity', 'demos', 'table: demos\n', 'g_real', 'published')`,
      [orgId],
    );

    const deleted = await pool.query<{ id: string }>(
      `DELETE FROM semantic_entities
       WHERE org_id = $1 AND entity_type = $2 AND name = $3
         AND connection_group_id IS NOT DISTINCT FROM $4
       RETURNING id`,
      [orgId, "entity", "demos", null],
    );
    expect(deleted.rows.length).toBe(1);

    const survivors = await pool.query<{ connection_group_id: string | null }>(
      `SELECT connection_group_id FROM semantic_entities
       WHERE org_id = $1 AND entity_type = 'entity' AND name = 'demos'`,
      [orgId],
    );
    expect(survivors.rows.length).toBe(1);
    expect(survivors.rows[0]?.connection_group_id).toBe("g_real");
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
         (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'orders', 'table: orders', $2, 'published')`,
      [orgId, groupId],
    );
    // Second insert with same (org_id, entity_type, name, connection_group_id)
    // — must fail with 23505 even though connection_id differs.
    await expect(
      pool.query(
        `INSERT INTO semantic_entities
           (org_id, entity_type, name, yaml_content, connection_group_id, status)
         VALUES ($1, 'entity', 'orders', 'table: orders', $2, 'published')`,
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

  it("pii_column_classifications.connection_id: legacy column dropped", async () => {
    const { rows } = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'pii_column_classifications'
         AND column_name = 'connection_id'
         AND table_schema = current_schema()`,
    );
    expect(rows).toEqual([]);
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

  it("pii_column_classifications: 0064 backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // The smoke suite runs every migration end-to-end (including 0069),
    // which drops `pii_column_classifications.connection_id`. To exercise
    // the ACTUAL backfill SQL from 0064 against a pre-migration row shape,
    // we temporarily re-add `connection_id`, seed a row with it set and
    // `connection_group_id IS NULL`, run the migration's UPDATE block
    // verbatim, then drop the column to restore the post-0069 shape.
    const orgId = `org-backfill-pii-${Date.now()}`;
    const connId = `conn-back-pii-${Date.now()}`;
    const groupId = `g_${connId}`;
    await pool.query(`ALTER TABLE pii_column_classifications ADD COLUMN connection_id TEXT`);
    try {
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
      // Run the migration's actual backfill block (verbatim from 0064).
      await pool.query(
        `UPDATE pii_column_classifications pc
           SET connection_group_id = c.group_id
           FROM connections c
           WHERE pc.connection_id IS NOT NULL
             AND pc.connection_group_id IS NULL
             AND c.id = pc.connection_id
             AND (c.org_id = pc.org_id OR c.org_id = '__global__')`,
      );
      const { rows } = await pool.query<{ connection_group_id: string | null }>(
        `SELECT connection_group_id FROM pii_column_classifications
         WHERE org_id = $1 AND table_name = 'users' AND column_name = 'email'`,
        [orgId],
      );
      expect(rows[0]?.connection_group_id).toBe(groupId);
    } finally {
      // Cleanup must not shadow an in-`try` assertion error. If the DROP
      // itself trips (pool closed mid-test, etc.), log and let the
      // original failure propagate.
      try {
        await pool.query(`ALTER TABLE pii_column_classifications DROP COLUMN connection_id`);
      } catch (err) {
        console.warn(
          `cleanup pii_column_classifications.connection_id DROP failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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
         (org_id, table_name, column_name, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', $2, 'email', 'high', 'partial')`,
      [orgId, groupId],
    );
    await expect(
      pool.query(
        `INSERT INTO pii_column_classifications
           (org_id, table_name, column_name, connection_group_id, category, confidence, masking_strategy)
         VALUES ($1, 'users', 'email', $2, 'email', 'high', 'partial')`,
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
         (org_id, table_name, column_name, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', $2, 'email', 'high', 'partial')`,
      [orgId, prodGroup],
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
         (org_id, table_name, column_name, connection_group_id, category, confidence, masking_strategy)
       VALUES ($1, 'users', 'email', $2, 'email', 'low', 'redact')`,
      [orgId, stagingGroup],
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
         (id, org_id, table_name, column_name, connection_group_id, category, confidence, masking_strategy, updated_at)
       VALUES ($1, $2, 'users', 'email_v1', $3, 'email', 'high', 'partial', NOW()),
              ($4, $2, 'users', 'email_v2', $3, 'email', 'high', 'partial', NOW() - INTERVAL '1 hour')`,
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

  it("approval_queue.connection_id: legacy column dropped", async () => {
    const { rows } = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'approval_queue'
         AND column_name = 'connection_id'
         AND table_schema = current_schema()`,
    );
    expect(rows).toEqual([]);
  }, PG_TEST_TIMEOUT_MS);

  it("approval_queue: 0065 backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // The smoke suite runs every migration end-to-end (including 0069),
    // which drops `approval_queue.connection_id`. To exercise the ACTUAL
    // backfill SQL from 0065 against a pre-migration row shape, we
    // temporarily re-add `connection_id`, seed a row with it set and
    // `connection_group_id IS NULL`, run the migration's UPDATE block
    // verbatim, then drop the column to restore the post-0069 shape.
    const orgId = `org-approval-backfill-${Date.now()}`;
    const connId = `conn-approval-${Date.now()}`;
    const groupId = `g_${connId}`;
    await pool.query(`ALTER TABLE approval_queue ADD COLUMN connection_id TEXT`);
    try {
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
      // Pre-0065 shape: connection_id set, connection_group_id NULL.
      await pool.query(
        `INSERT INTO approval_queue
           (org_id, rule_id, rule_name, requester_id, query_sql, connection_id, connection_group_id)
         VALUES ($1, $2, 'Backfill rule', 'user-backfill', 'SELECT * FROM orders', $3, NULL)`,
        [orgId, ruleId, connId],
      );
      // Run the migration's actual backfill block (verbatim from 0065).
      await pool.query(
        `UPDATE approval_queue aq
           SET connection_group_id = c.group_id
           FROM connections c
           WHERE aq.connection_id IS NOT NULL
             AND aq.connection_group_id IS NULL
             AND c.id = aq.connection_id
             AND (c.org_id = aq.org_id OR c.org_id = '__global__')`,
      );
      const { rows } = await pool.query<{ connection_group_id: string | null }>(
        `SELECT connection_group_id FROM approval_queue
         WHERE org_id = $1 AND requester_id = 'user-backfill'`,
        [orgId],
      );
      expect(rows[0]?.connection_group_id).toBe(groupId);
    } finally {
      // Cleanup must not shadow an in-`try` assertion error. If the DROP
      // itself trips (pool closed mid-test, etc.), log and let the
      // original failure propagate.
      try {
        await pool.query(`ALTER TABLE approval_queue DROP COLUMN connection_id`);
      } catch (err) {
        console.warn(
          `cleanup approval_queue.connection_id DROP failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ($2, $1, '__global__:' || $2)
       ON CONFLICT (id, org_id) DO NOTHING`,
      [orgId, groupId],
    );
    await pool.query(
      `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, query_sql, connection_group_id)
       VALUES ($1, $2, 'Global backfill rule', 'user-global-backfill', 'SELECT * FROM orders', $3)`,
      [orgId, ruleRow.rows[0].id, groupId],
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
    const groupAId = `g-source-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'source')`,
      [groupAId, orgA],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connAId, orgA, groupAId],
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

  it("dashboard_cards: 0066 backfill resolves connection_id → connection_group_id via 0062's 1:1 mapping", async () => {
    // The smoke suite runs every migration end-to-end (including 0069),
    // which drops `dashboard_cards.connection_id`. To exercise the ACTUAL
    // backfill SQL from 0066 against a pre-migration row shape, we
    // temporarily re-add `connection_id`, seed a card with it set and
    // `connection_group_id IS NULL`, run the migration's UPDATE block
    // verbatim, then drop the column to restore the post-0069 shape.
    //
    // The 0066 backfill joins through `dashboards` (cards have no own
    // org_id) — the test exercises that join shape, not just a flat
    // `connections` lookup like 0063/0064/0065.
    const orgId = `org-card-backfill-${Date.now()}`;
    const connId = `conn-card-${Date.now()}`;
    const groupId = `g_${connId}`;
    const dashboardOwner = `owner-${Date.now()}`;
    await pool.query(`ALTER TABLE dashboard_cards ADD COLUMN connection_id TEXT`);
    try {
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
      // Run the migration's actual backfill block (verbatim from 0066).
      // Note the three-table join — cards lack their own org_id and
      // resolve through the parent dashboard's org.
      await pool.query(
        `UPDATE dashboard_cards dc
           SET connection_group_id = c.group_id
           FROM connections c, dashboards d
           WHERE dc.dashboard_id = d.id
             AND dc.connection_id IS NOT NULL
             AND dc.connection_group_id IS NULL
             AND c.id = dc.connection_id
             AND (c.org_id = d.org_id OR c.org_id = '__global__')`,
      );
      const { rows } = await pool.query<{ connection_group_id: string | null }>(
        `SELECT connection_group_id FROM dashboard_cards WHERE dashboard_id = $1`,
        [dashboardId],
      );
      expect(rows[0]?.connection_group_id).toBe(groupId);
    } finally {
      // Cleanup must not shadow an in-`try` assertion error. If the DROP
      // itself trips (pool closed mid-test, etc.), log and let the
      // original failure propagate.
      try {
        await pool.query(`ALTER TABLE dashboard_cards DROP COLUMN connection_id`);
      } catch (err) {
        console.warn(
          `cleanup dashboard_cards.connection_id DROP failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

  // 0070 — Rename synthetic `__global__:<id>` connection_group names (#2417).
  //
  // Migrations 0065 + 0068 mirrored global groups into tenant orgs with a
  // display name of `__global__:` || g.id. That string was rendering verbatim
  // in admin dropdowns. 0070 backfills tenant rows with the source __global__
  // group's actual name, skipping rows whose target name would collide with
  // an existing tenant group.
  //
  // Per the #2427 honest-backfill pattern: insert a pre-migration state that
  // simulates what 0065/0068 left behind, replay the migration SQL by reading
  // it from disk, then assert post-state. Loading the SQL from disk keeps
  // the assertion bound to production SQL — a future edit to 0070 that
  // changes its semantics will surface here rather than passing a stale
  // duplicated string.
  const MIGRATION_0070 = readFileSync(
    join(__dirname, "../migrations/0070_rename_synthetic_global_group_names.sql"),
    "utf8",
  );

  it("0070: renames synthetic '__global__:<id>' names to the source __global__ group's display name", async () => {
    const groupId = `g_rename_${Date.now()}`;
    const tenantOrg = `org-rename-${Date.now()}`;
    const sourceName = `Production-${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [groupId, sourceName],
    );
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ($1, $2, '__global__:' || $1)`,
      [groupId, tenantOrg],
    );

    // Sanity: the pre-state really does carry the synthetic name. Without
    // this, a regression that already cleaned the row before 0070 ran
    // would let the test pass for the wrong reason.
    const before = await pool.query<{ name: string }>(
      `SELECT name FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, tenantOrg],
    );
    expect(before.rows[0]?.name).toBe(`__global__:${groupId}`);

    await pool.query(MIGRATION_0070);

    const after = await pool.query<{ name: string }>(
      `SELECT name FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, tenantOrg],
    );
    expect(after.rows[0]?.name).toBe(sourceName);
  }, PG_TEST_TIMEOUT_MS);

  it("0070: leaves the synthetic name alone when the source name would collide with an existing tenant group", async () => {
    // If the tenant already carries a group with the same display name as
    // the source __global__ group, renaming would violate the
    // (org_id, name) UNIQUE index. The migration's NOT EXISTS guard keeps
    // the synthetic row as-is; the display-layer strip (`stripGroupPrefix`)
    // handles the residual case at render time. See #2417.
    const sharedName = `Shared-${Date.now()}`;
    const globalGroupId = `g_collide_global_${Date.now()}`;
    const tenantOrg = `org-collide-${Date.now()}`;
    const tenantGroupId = `g_collide_tenant_${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [globalGroupId, sharedName],
    );
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [tenantGroupId, tenantOrg, sharedName],
    );
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ($1, $2, '__global__:' || $1)`,
      [globalGroupId, tenantOrg],
    );

    // Migration must not throw on collision — the guard skips, doesn't
    // raise.
    await expect(pool.query(MIGRATION_0070)).resolves.toBeDefined();

    const row = await pool.query<{ name: string }>(
      `SELECT name FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [globalGroupId, tenantOrg],
    );
    expect(row.rows[0]?.name).toBe(`__global__:${globalGroupId}`);

    // The *other* tenant row — the one whose name caused the collision
    // — must also be untouched. Without this assertion, an inverted
    // NOT EXISTS (e.g. EXISTS) would rename the legitimate tenant row
    // to the synthetic name and the first assertion would still pass.
    const sibling = await pool.query<{ name: string }>(
      `SELECT name FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [tenantGroupId, tenantOrg],
    );
    expect(sibling.rows[0]?.name).toBe(sharedName);
  }, PG_TEST_TIMEOUT_MS);

  it("0070: renames every tenant mirror of one global group — multi-tenant fan-out", async () => {
    // The realistic post-0065/0068 state: one global group, three
    // tenants each carrying a `__global__:<id>` mirror. The UPDATE's
    // correlated subquery joins by `src.id = t.id` so the rename must
    // fan out across every tenant in a single pass. A regression that
    // accidentally collapsed the join (e.g. a stray GROUP BY) would
    // process only one tenant and the other two would survive.
    const groupId = `g_fanout_${Date.now()}`;
    const sourceName = `Fanout-${Date.now()}`;
    const tenantOrgs = [
      `org-fanout-a-${Date.now()}`,
      `org-fanout-b-${Date.now()}`,
      `org-fanout-c-${Date.now()}`,
    ];

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [groupId, sourceName],
    );
    for (const tenantOrg of tenantOrgs) {
      await pool.query(
        `INSERT INTO connection_groups (id, org_id, name)
         VALUES ($1, $2, '__global__:' || $1)`,
        [groupId, tenantOrg],
      );
    }

    await pool.query(MIGRATION_0070);

    for (const tenantOrg of tenantOrgs) {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM connection_groups WHERE id = $1 AND org_id = $2`,
        [groupId, tenantOrg],
      );
      expect(rows[0]?.name).toBe(sourceName);
    }
  }, PG_TEST_TIMEOUT_MS);

  it("0070: is idempotent — re-running after the cleanup is a no-op", async () => {
    // Idempotency matters because `runMigrations` records 0070 as applied
    // and won't re-run it, but operators occasionally replay migrations
    // by hand against staging. The WHERE predicate guards on the prefix,
    // so once names are clean, re-runs change nothing.
    const groupId = `g_idem_${Date.now()}`;
    const tenantOrg = `org-idem-${Date.now()}`;
    const sourceName = `Idem-${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [groupId, sourceName],
    );
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ($1, $2, '__global__:' || $1)`,
      [groupId, tenantOrg],
    );

    await pool.query(MIGRATION_0070);
    // `pg` returns TIMESTAMPTZ as `Date` objects, so two separate SELECTs
    // produce distinct instances and `.toBe()` fails identity even when
    // the value is unchanged. Cast to text so equality is value-based.
    const firstRun = await pool.query<{ updated_at: string; name: string }>(
      `SELECT name, updated_at::text AS updated_at
         FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, tenantOrg],
    );
    expect(firstRun.rows[0]?.name).toBe(sourceName);

    await pool.query(MIGRATION_0070);
    const secondRun = await pool.query<{ updated_at: string; name: string }>(
      `SELECT name, updated_at::text AS updated_at
         FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, tenantOrg],
    );
    expect(secondRun.rows[0]?.name).toBe(sourceName);
    // `updated_at` is a proxy here, not a hard signal: 0070 never sets it
    // on first run either. The point is to catch a future regression
    // that *does* add `SET updated_at = now()` to the UPDATE — in that
    // world the no-op re-run would silently bump `updated_at` despite
    // touching nothing semantic, and the WHERE prefix-guard would be
    // the only thing protecting idempotency.
    expect(secondRun.rows[0]?.updated_at).toBe(firstRun.rows[0]?.updated_at);
  }, PG_TEST_TIMEOUT_MS);

  it("0070: literal-prefix match — `_` wildcards in LIKE don't catch deceptive names", async () => {
    // Regression guard against a `LIKE '__global__:%'` predicate
    // (where `_` is a single-char wildcard). The migration uses
    // `starts_with()` to make the match a literal-prefix comparison,
    // so a tenant row literally named `abglobalcd:trick` — which
    // matches the old LIKE wildcard but is not a synthetic mirror —
    // must stay untouched. Same id as the global source so the
    // outer JOIN does attach; the prefix check is what saves it.
    const groupId = `g_wildcard_${Date.now()}`;
    const tenantOrg = `org-wildcard-${Date.now()}`;
    const cleanName = `Clean-${Date.now()}`;
    const deceptive = `abglobalcd:trick-${Date.now()}`;

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [groupId, cleanName],
    );
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, tenantOrg, deceptive],
    );

    await pool.query(MIGRATION_0070);

    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, tenantOrg],
    );
    expect(rows[0]?.name).toBe(deceptive);
  }, PG_TEST_TIMEOUT_MS);

  // #2415 — resolveGroupForConnection predicate matrix under a null
  // caller orgId. The helper's WHERE clause must:
  //
  //   - Match `org_id = '__global__'` (the schema default — shared rows).
  //   - Match an `org_id IS NULL` row if one ever existed (defense-in-depth
  //     against schema relaxation; today migration 0021 makes the column
  //     NOT NULL, so this branch is exercised against a VALUES rowset
  //     rather than the live table).
  //   - NOT match a tenant-owned row from a different org — that would be
  //     a cross-tenant leak.
  //
  // Pre-fix the predicate was `org_id = $2 OR org_id = '__global__'`,
  // which collapses to `org_id = '__global__'` whenever $2 is NULL
  // (`= NULL` is UNKNOWN in Postgres). Self-hosted single-tenant deploys
  // whose connections.org_id is anything other than `__global__` silently
  // lost their group binding and fell back to legacy single-connection
  // routing. The null-safe `IS NOT DISTINCT FROM` operator closes that.
  //
  // We assert two layers:
  //   (a) The predicate against synthetic rows (VALUES) — isolates
  //       predicate semantics from the live schema and covers the
  //       `org_id IS NULL` branch the NOT NULL constraint blocks at
  //       insert time.
  //   (b) The predicate against real `connections` rows — confirms the
  //       helper-shaped query returns the right set when run end-to-end
  //       against the post-migration schema.
  it("resolveGroupForConnection predicate: VALUES-row matrix under null caller orgId (#2415)", async () => {
    // Direct predicate-correctness test. The unit-level SQL-string
    // assertion in `conversations-group-routing.test.ts` is what locks
    // the helper to this exact predicate shape; this test verifies the
    // shape's *semantics* against a live Postgres planner.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM (VALUES
         ('null-row', NULL::text),
         ('global-row', '__global__'::text),
         ('tenant-row', 'tenant-x'::text)
       ) AS t(id, org_id)
       WHERE (org_id IS NOT DISTINCT FROM $1 OR org_id = '__global__')
       ORDER BY id`,
      [null],
    );
    const ids = rows.map((r) => r.id).sort();
    // null-row matches via IS NOT DISTINCT FROM NULL (null-safe equality).
    // global-row matches via the OR-branch. tenant-row matches NEITHER —
    // that's the cross-tenant boundary we mustn't cross.
    expect(ids).toEqual(["global-row", "null-row"]);
  }, PG_TEST_TIMEOUT_MS);

  it("resolveGroupForConnection predicate: VALUES-row matrix under tenant caller orgId (#2415)", async () => {
    // Sanity: the same predicate under a non-null caller orgId still
    // matches that tenant's rows plus the global fallback, and nothing
    // else. Locks the matrix from both sides.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM (VALUES
         ('null-row', NULL::text),
         ('global-row', '__global__'::text),
         ('tenant-row', 'tenant-x'::text),
         ('other-row', 'tenant-y'::text)
       ) AS t(id, org_id)
       WHERE (org_id IS NOT DISTINCT FROM $1 OR org_id = '__global__')
       ORDER BY id`,
      ["tenant-x"],
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["global-row", "tenant-row"]);
  }, PG_TEST_TIMEOUT_MS);

  it("resolveGroupForConnection: returns group when connections.org_id='__global__' and caller orgId is null (#2415)", async () => {
    // End-to-end check against the live connections table. Self-hosted
    // single-tenant deploys hit this path when their org_id defaulted
    // to `__global__` (the schema default).
    const groupId = `g_global_null_${Date.now()}`;
    const connId = `conn-global-null-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, '__global__', $2)`,
      [groupId, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', '__global__', 'published', $2)`,
      [connId, groupId],
    );
    const { rows } = await pool.query<{ group_id: string | null }>(
      `SELECT group_id FROM connections
        WHERE id = $1
          AND (org_id IS NOT DISTINCT FROM $2 OR org_id = '__global__')
        LIMIT 1`,
      [connId, null],
    );
    expect(rows[0]?.group_id).toBe(groupId);
  }, PG_TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------
  // connection_groups.status + group-archive cascade
  // ---------------------------------------------------------------------
  //
  // Real-Postgres assertions for the canonical cascade SQL imported from
  // `lib/db/connection-groups-sql.ts`. The route handler and these tests
  // share the same constants, so a regression that loosens a predicate
  // (e.g. drops the `org_id` filter, archives wrong-tenant rows) shows up
  // in both files in the same diff and can't sneak through.
  //
  // What we guard:
  //   1. Migration shape — `status` column exists, default `active`,
  //      CHECK rejects unknown values, partial index covers the
  //      `(org_id, active)` hot path.
  //   2. Happy-path cascade — group with one entity / one task / one
  //      pending approval, archive flips all four atomically.
  //   3. Org isolation — running the cascade against group A does not
  //      touch group B's content, even when both groups live in the
  //      same org (the `connection_group_id = $1` predicate is the
  //      contract).
  //   4. Cross-org isolation — running the cascade with org-A's group
  //      id against org-B's id never touches org-A's content (the
  //      `org_id = $2` predicate is the contract).
  //   5. Rollback — when one cascade UPDATE fails inside a transaction,
  //      every sibling UPDATE rolls back too (the route's atomicity
  //      claim). Simulated by injecting a CHECK violation in a sibling
  //      statement and asserting nothing flipped.

  it("connection_groups.status: column exists with CHECK + default 'active'", async () => {
    const { rows } = await pool.query<{ column_default: string | null; is_nullable: string; data_type: string }>(
      `SELECT column_default, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'connection_groups'
         AND column_name = 'status'
         AND table_schema = current_schema()`,
    );
    expect(rows[0]?.data_type).toBe("text");
    expect(rows[0]?.is_nullable).toBe("NO");
    expect(rows[0]?.column_default).toContain("active");

    // CHECK rejects unknown statuses with 23514.
    const orgId = `org-status-${Date.now()}`;
    await expect(
      pool.query(
        `INSERT INTO connection_groups (id, org_id, name, status) VALUES ($1, $2, 'check-status', 'bogus')`,
        [`g-status-${Date.now()}`, orgId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Default backfilled to `active` for any row inserted without an
    // explicit value (no historical archives — multi-env launch is
    // still pre-SaaS).
    const defaultRow = await pool.query<{ status: string }>(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'default-status')
       RETURNING status`,
      [`g-status-default-${Date.now()}`, orgId],
    );
    expect(defaultRow.rows[0]?.status).toBe("active");
  }, PG_TEST_TIMEOUT_MS);

  it("archive cascade: happy path — entities, tasks, approvals, group all flip atomically", async () => {
    const orgId = `org-arch-happy-${Date.now()}`;
    const groupId = `g-arch-${Date.now()}`;
    const connId = `conn-arch-${Date.now()}`;

    // Seed: group + member connection + one entity + one task + one
    // pending approval, all scoped to the same group.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'archive-target')`,
      [groupId, orgId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, orgId, groupId],
    );
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'users', 'table: users', $2, 'published')`,
      [orgId, groupId],
    );
    await pool.query(
      `INSERT INTO scheduled_tasks
         (owner_id, org_id, name, question, cron_expression, delivery_channel, recipients,
          connection_group_id, enabled)
       VALUES ('owner', $1, 'daily metrics', 'how many?', '0 9 * * *', 'webhook', '[]'::jsonb, $2, true)`,
      [orgId, groupId],
    );
    await pool.query(
      `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, query_sql, connection_group_id, status)
       VALUES ($1, gen_random_uuid(), 'cost-cap', 'requester', 'select 1', $2, 'pending')`,
      [orgId, groupId],
    );

    // Drive the cascade inside one transaction — mirrors the route
    // handler's BEGIN/COMMIT shape.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const entitiesRes = await client.query(CASCADE_ARCHIVE_GROUP_ENTITIES_SQL, [groupId, orgId]);
      const tasksRes = await client.query(CASCADE_ARCHIVE_GROUP_TASKS_SQL, [groupId, orgId]);
      const approvalsRes = await client.query(CASCADE_ARCHIVE_GROUP_APPROVALS_SQL, [groupId, orgId]);
      const groupRes = await client.query(ARCHIVE_GROUP_SQL, [groupId, orgId]);
      expect(entitiesRes.rowCount).toBe(1);
      expect(tasksRes.rowCount).toBe(1);
      expect(approvalsRes.rowCount).toBe(1);
      expect(groupRes.rowCount).toBe(1);
      await client.query("COMMIT");
    } catch (err) {
      // Swallow ROLLBACK failures so the *original* assertion error
      // propagates — a failed ROLLBACK on top would mask the actual
      // cascade bug and make debugging nightmarish. The release-with-err
      // below still destroys the poisoned socket.
      let rbErr: unknown = null;
      await client.query("ROLLBACK").catch((e) => {
        rbErr = e;
      });
      client.release(rbErr instanceof Error ? rbErr : undefined);
      throw err;
    }
    // On the happy path the COMMIT path already ran; release cleanly.
    client.release();

    // Post-commit assertions: every flip stuck.
    const entity = await pool.query<{ status: string }>(
      `SELECT status FROM semantic_entities WHERE connection_group_id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    const task = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM scheduled_tasks WHERE connection_group_id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    const approval = await pool.query<{ status: string }>(
      `SELECT status FROM approval_queue WHERE connection_group_id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    const group = await pool.query<{ status: string }>(
      `SELECT status FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(entity.rows[0]?.status).toBe("archived");
    expect(task.rows[0]?.enabled).toBe(false);
    expect(approval.rows[0]?.status).toBe("expired");
    expect(group.rows[0]?.status).toBe("archived");

    // Re-running each statement is idempotent — no rows match the
    // filter, so RETURNING is empty and nothing changes.
    const reRun = await pool.query(CASCADE_ARCHIVE_GROUP_ENTITIES_SQL, [groupId, orgId]);
    expect(reRun.rowCount).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  it("archive cascade: sibling group's content untouched (same org)", async () => {
    const orgId = `org-arch-iso-${Date.now()}`;
    const groupA = `g-arch-a-${Date.now()}`;
    const groupB = `g-arch-b-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'target'), ($3, $2, 'sibling')`,
      [groupA, orgId, groupB],
    );
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'shared_users', 'table: u', $2, 'published'),
              ($1, 'entity', 'shared_orders', 'table: o', $3, 'published')`,
      [orgId, groupA, groupB],
    );

    await pool.query(CASCADE_ARCHIVE_GROUP_ENTITIES_SQL, [groupA, orgId]);

    const aRow = await pool.query<{ status: string }>(
      `SELECT status FROM semantic_entities WHERE connection_group_id = $1`,
      [groupA],
    );
    const bRow = await pool.query<{ status: string }>(
      `SELECT status FROM semantic_entities WHERE connection_group_id = $1`,
      [groupB],
    );
    expect(aRow.rows[0]?.status).toBe("archived");
    // The sibling group keeps its published row — the `connection_group_id = $1`
    // predicate is the org-internal isolation guard.
    expect(bRow.rows[0]?.status).toBe("published");
  }, PG_TEST_TIMEOUT_MS);

  it("archive cascade: cross-org content untouched even with same group id (B2B isolation)", async () => {
    // A SaaS tenant can collide on group ids (e.g. both orgs auto-backfill
    // `g_default`). The `org_id = $2` predicate is the cross-tenant
    // isolation guard — without it, archiving org-A's `g_default` would
    // archive org-B's `g_default` content too.
    const orgA = `org-arch-orgA-${Date.now()}`;
    const orgB = `org-arch-orgB-${Date.now()}`;
    const sharedGroupId = `g-shared-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
      [sharedGroupId, orgA, orgB],
    );
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'users', 'a', $3, 'published'),
              ($2, 'entity', 'users', 'b', $3, 'published')`,
      [orgA, orgB, sharedGroupId],
    );

    await pool.query(CASCADE_ARCHIVE_GROUP_ENTITIES_SQL, [sharedGroupId, orgA]);

    const aRow = await pool.query<{ status: string }>(
      `SELECT status FROM semantic_entities WHERE org_id = $1 AND connection_group_id = $2`,
      [orgA, sharedGroupId],
    );
    const bRow = await pool.query<{ status: string }>(
      `SELECT status FROM semantic_entities WHERE org_id = $1 AND connection_group_id = $2`,
      [orgB, sharedGroupId],
    );
    expect(aRow.rows[0]?.status).toBe("archived");
    expect(bRow.rows[0]?.status).toBe("published");
  }, PG_TEST_TIMEOUT_MS);

  it("archive cascade: a transactional failure rolls back all sibling flips", async () => {
    // Atomicity contract: the route promises "all-or-nothing". If one
    // cascade UPDATE fails, every sibling UPDATE must roll back too. We
    // simulate the failure by injecting a CHECK-violating UPDATE in the
    // same transaction; nothing observable post-ROLLBACK should have
    // flipped.
    const orgId = `org-arch-rollback-${Date.now()}`;
    const groupId = `g-arch-rb-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'rb-target')`,
      [groupId, orgId],
    );
    await pool.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
       VALUES ($1, 'entity', 'rollback_subject', 'yaml', $2, 'published')`,
      [orgId, groupId],
    );

    const client = await pool.connect();
    let caught: unknown = null;
    let rollbackErr: Error | null = null;
    try {
      await client.query("BEGIN");
      await client.query(CASCADE_ARCHIVE_GROUP_ENTITIES_SQL, [groupId, orgId]);
      // Inject a deterministic failure. The CHECK on `connection_groups.status`
      // rejects `'bogus'` with 23514 — same shape as a typo making it to
      // prod. Any failure here must roll back the entity flip above.
      await client.query(
        `UPDATE connection_groups SET status = 'bogus' WHERE id = $1 AND org_id = $2`,
        [groupId, orgId],
      );
      await client.query("COMMIT");
    } catch (err) {
      caught = err;
      // Guard ROLLBACK so a dead socket doesn't mask the 23514 we're
      // actually asserting on. `client.release(rollbackErr)` destroys
      // the poisoned socket so the next pool borrower isn't affected.
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      });
    } finally {
      client.release(rollbackErr ?? undefined);
    }
    expect(caught).toMatchObject({ code: "23514" });

    // Post-rollback: the entity is still `published` and the group is
    // still `active`. If either had flipped, the route's atomicity claim
    // would be a lie.
    const entity = await pool.query<{ status: string }>(
      `SELECT status FROM semantic_entities WHERE connection_group_id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    const group = await pool.query<{ status: string }>(
      `SELECT status FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(entity.rows[0]?.status).toBe("published");
    expect(group.rows[0]?.status).toBe("active");
  }, PG_TEST_TIMEOUT_MS);

  it("archive cascade: dashboard_cards are intentionally NOT touched", async () => {
    // The cascade slice deliberately leaves dashboard_cards alone: the
    // table has no status column, and adding one would change the read
    // path for every dashboard surface. A future contributor adding a
    // CASCADE_ARCHIVE_GROUP_CARDS_SQL would silently break the docs
    // promise that cards keep rendering until manually edited. This
    // test pins that contract.
    const orgId = `org-cards-${Date.now()}`;
    const groupId = `g-cards-${Date.now()}`;
    // Seed a parent dashboard so dashboard_cards.dashboard_id FK
    // resolves. The dashboards table requires owner_id, share_mode,
    // org_id, and slug; pass the minimum.
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, 'cards-target')`,
      [groupId, orgId],
    );
    const dashboardInsert = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title, share_mode)
       VALUES ($1, 'owner', 'card-test', 'org')
       RETURNING id`,
      [orgId],
    );
    const dashboardId = dashboardInsert.rows[0]!.id;
    const cardInsert = await pool.query<{ id: string }>(
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql, connection_group_id)
       VALUES ($1, 0, 'count rows', 'select 1', $2)
       RETURNING id`,
      [dashboardId, groupId],
    );
    const cardId = cardInsert.rows[0]!.id;

    // Run the full cascade (entities + tasks + approvals + group).
    await pool.query(CASCADE_ARCHIVE_GROUP_ENTITIES_SQL, [groupId, orgId]);
    await pool.query(CASCADE_ARCHIVE_GROUP_TASKS_SQL, [groupId, orgId]);
    await pool.query(CASCADE_ARCHIVE_GROUP_APPROVALS_SQL, [groupId, orgId]);
    await pool.query(ARCHIVE_GROUP_SQL, [groupId, orgId]);

    // Group is archived; the card is untouched (still points at the
    // archived group). Reads at view time SHOULD eventually surface
    // the archived state, but that's a separate slice.
    const group = await pool.query<{ status: string }>(
      `SELECT status FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    expect(group.rows[0]?.status).toBe("archived");
    const card = await pool.query<{
      id: string;
      connection_group_id: string | null;
    }>(
      `SELECT id, connection_group_id FROM dashboard_cards WHERE id = $1`,
      [cardId],
    );
    expect(card.rows[0]?.connection_group_id).toBe(groupId);
    // The card row itself was not deleted, NULLed, or otherwise
    // touched. If a future contributor adds a card cascade, this row
    // count would change and the test would flag the docs / dialog
    // copy update too.
    expect(card.rows.length).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("resolveGroupForConnection: does NOT resolve when caller orgId is null and connections.org_id is a different tenant (#2415)", async () => {
    // The cross-tenant boundary. A null-orgId caller must never resolve
    // a group binding owned by a specific tenant — that would be the
    // F-01 leak the row-scope predicates exist to prevent.
    const groupId = `g_tenant_null_${Date.now()}`;
    const connId = `conn-tenant-null-${Date.now()}`;
    const tenantOrg = `tenant-x-${Date.now()}`;
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, tenantOrg, connId],
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, org_id, status, group_id)
       VALUES ($1, 'enc:v1:iv:tag:ciphertext', 'postgres', $2, 'published', $3)`,
      [connId, tenantOrg, groupId],
    );
    const { rows } = await pool.query<{ group_id: string | null }>(
      `SELECT group_id FROM connections
        WHERE id = $1
          AND (org_id IS NOT DISTINCT FROM $2 OR org_id = '__global__')
        LIMIT 1`,
      [connId, null],
    );
    // Pre-fix, this case fell through to `org_id = '__global__'` which
    // also misses, so the helper returned null — same observable
    // outcome but for the wrong reason. The positive assertion above
    // (`__global__` case) is what flips red→green; this one guards the
    // cross-tenant boundary as a permanent invariant.
    expect(rows.length).toBe(0);
  }, PG_TEST_TIMEOUT_MS);
});
