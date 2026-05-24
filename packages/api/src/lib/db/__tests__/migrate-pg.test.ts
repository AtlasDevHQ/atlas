import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
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


  // ─────────────────────────────────────────────────────────────────────
  // 0073 — conversations.bound_dashboard_id (#2363)
  // ─────────────────────────────────────────────────────────────────────

  it("0073: conversations.bound_dashboard_id is a nullable uuid (#2363)", async () => {
    const { rows } = await pool.query<{
      data_type: string;
      is_nullable: string;
      udt_name: string;
    }>(
      `SELECT data_type, is_nullable, udt_name
         FROM information_schema.columns
        WHERE table_name = 'conversations'
          AND column_name = 'bound_dashboard_id'
          AND table_schema = current_schema()`,
    );
    expect(rows[0]?.udt_name).toBe("uuid");
    expect(rows[0]?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("0073: ON DELETE SET NULL preserves the conversation when its dashboard is removed (#2363)", async () => {
    const stamp = Date.now();
    const orgId = `org-2363-${stamp}`;
    const dashRows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, 'u-2363', 'Bound test') RETURNING id`,
      [orgId],
    );
    const dashboardId = dashRows.rows[0]?.id as string;

    const convRows = await pool.query<{ id: string }>(
      `INSERT INTO conversations (user_id, org_id, bound_dashboard_id)
       VALUES ('u-2363', $1, $2)
       RETURNING id`,
      [orgId, dashboardId],
    );
    const conversationId = convRows.rows[0]?.id as string;

    // Sanity — binding stuck.
    const bound = await pool.query<{ bound_dashboard_id: string | null }>(
      `SELECT bound_dashboard_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(bound.rows[0]?.bound_dashboard_id).toBe(dashboardId);

    // Hard-delete the dashboard. The FK is ON DELETE SET NULL, so the
    // conversation row must survive with the pointer cleared.
    await pool.query(`DELETE FROM dashboards WHERE id = $1`, [dashboardId]);
    const after = await pool.query<{ bound_dashboard_id: string | null }>(
      `SELECT bound_dashboard_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0]?.bound_dashboard_id).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------
  // proactive_pauses (#2295)
  // ---------------------------------------------------------------------------

  it("proactive_pauses: layer CHECK constraint rejects unknown values (#2295)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pp-bad-${stamp}`;
    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO proactive_pauses (workspace_id, channel_id, user_id, layer)
         VALUES ($1, NULL, NULL, 'not-a-real-layer')`,
        [ws],
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    // 23514 = check_violation
    expect(err?.message).toMatch(/chk_proactive_pauses_layer|23514|check constraint/i);
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_pauses: stores all four canonical layers (#2295)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pp-canon-${stamp}`;
    const channelId = `C-${stamp}`;
    const userId = `U-${stamp}`;

    await pool.query(
      `INSERT INTO proactive_pauses (workspace_id, channel_id, user_id, layer, expires_at)
       VALUES
         ($1, NULL,        NULL,    'workspace-kill', NULL),
         ($1, $2::text,    NULL,    'admin-channel',  NULL),
         ($1, NULL,        $3::text, 'user-optout',   NULL),
         ($1, $2::text,    NULL,    'channel-24h',    NOW() + INTERVAL '24 hours')`,
      [ws, channelId, userId],
    );

    const { rows } = await pool.query<{ layer: string }>(
      `SELECT layer FROM proactive_pauses WHERE workspace_id = $1 ORDER BY layer`,
      [ws],
    );
    expect(rows.map((r) => r.layer).sort()).toEqual([
      "admin-channel",
      "channel-24h",
      "user-optout",
      "workspace-kill",
    ]);
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_pauses: expired-row predicate works in WHERE (#2295)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pp-exp-${stamp}`;
    const channelId = `C-${stamp}`;

    // Two channel-24h rows: one already expired, one still active.
    await pool.query(
      `INSERT INTO proactive_pauses (workspace_id, channel_id, layer, expires_at) VALUES
         ($1, $2, 'channel-24h', NOW() - INTERVAL '1 hour'),
         ($1, $2, 'channel-24h', NOW() + INTERVAL '1 hour')`,
      [ws, channelId],
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM proactive_pauses
        WHERE workspace_id = $1
          AND channel_id = $2
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [ws, channelId],
    );
    expect(rows.length).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_pauses: lookup index is used for (workspace, channel) scans (#2295)", async () => {
    // Sanity-check that the lookup index exists by name — EXPLAIN ANALYZE
    // would be heavier; the index presence test is enough for drift detection.
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'proactive_pauses'
        ORDER BY indexname`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("idx_proactive_pauses_lookup");
    expect(names).toContain("idx_proactive_pauses_user");
  }, PG_TEST_TIMEOUT_MS);

  // ─────────────────────────────────────────────────────────────────────
  // 0079 — dashboard_user_drafts (#2364)
  //
  // Per-user drafts off a published baseline (PRD #2362). Three real-PG
  // assertions matter:
  //   1. Column shape — user_id text, dashboard_id uuid, draft + baseline
  //      jsonb, published_baseline_at timestamptz, all NOT NULL.
  //   2. Composite PK on (user_id, dashboard_id) — second insert with
  //      the same pair UPSERTs onto the existing row (acceptance:
  //      "two browser tabs by the same user stay on the same draft").
  //   3. ON DELETE CASCADE — deleting the dashboard takes every editor's
  //      draft with it (matches dashboard_cards cascade).
  // ─────────────────────────────────────────────────────────────────────

  it("0079: dashboard_user_drafts column shape — text user_id, uuid dashboard_id, jsonb draft + baseline, NOT NULL (#2364)", async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'dashboard_user_drafts'
          AND table_schema = current_schema()
        ORDER BY ordinal_position`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get("user_id")?.udt_name).toBe("text");
    expect(byName.get("user_id")?.is_nullable).toBe("NO");
    expect(byName.get("dashboard_id")?.udt_name).toBe("uuid");
    expect(byName.get("dashboard_id")?.is_nullable).toBe("NO");
    expect(byName.get("draft")?.udt_name).toBe("jsonb");
    expect(byName.get("draft")?.is_nullable).toBe("NO");
    expect(byName.get("baseline")?.udt_name).toBe("jsonb");
    expect(byName.get("baseline")?.is_nullable).toBe("NO");
    expect(byName.get("published_baseline_at")?.udt_name).toBe("timestamptz");
    expect(byName.get("published_baseline_at")?.is_nullable).toBe("NO");
  }, PG_TEST_TIMEOUT_MS);

  it("0079: composite PK on (user_id, dashboard_id) — second insert with same pair conflicts (#2364)", async () => {
    const stamp = Date.now();
    const orgId = `org-2364-${stamp}`;
    const dashRows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, 'u-2364', 'Drafts PK test') RETURNING id`,
      [orgId],
    );
    const dashboardId = dashRows.rows[0]?.id as string;
    const userId = `u-2364-${stamp}`;

    await pool.query(
      `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, now())`,
      [userId, dashboardId, JSON.stringify({ cards: [] }), JSON.stringify({ cards: [] })],
    );

    // Same pair → unique violation 23505.
    let dupErr: { code?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, now())`,
        [userId, dashboardId, JSON.stringify({ cards: [{}] }), JSON.stringify({ cards: [] })],
      );
    } catch (err) {
      dupErr = err as { code?: string };
    }
    expect(dupErr?.code).toBe("23505");

    // Different user, same dashboard → independent row, no conflict.
    const otherUser = `u-2364-other-${stamp}`;
    await pool.query(
      `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, now())`,
      [otherUser, dashboardId, JSON.stringify({ cards: [] }), JSON.stringify({ cards: [] })],
    );
    const { rows: count } = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM dashboard_user_drafts WHERE dashboard_id = $1`,
      [dashboardId],
    );
    expect(count[0]?.c).toBe(2);
  }, PG_TEST_TIMEOUT_MS);

  it("0079: ON DELETE CASCADE — dropping the parent dashboard drops every editor's draft (#2364)", async () => {
    const stamp = Date.now();
    const orgId = `org-2364-cascade-${stamp}`;
    const dashRows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, 'u-2364', 'Cascade test') RETURNING id`,
      [orgId],
    );
    const dashboardId = dashRows.rows[0]?.id as string;
    await pool.query(
      `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, now()),
              ($3, $2, '{}'::jsonb, '{}'::jsonb, now())`,
      [`u-2364-a-${stamp}`, dashboardId, `u-2364-b-${stamp}`],
    );

    const beforeCount = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM dashboard_user_drafts WHERE dashboard_id = $1`,
      [dashboardId],
    );
    expect(beforeCount.rows[0]?.c).toBe(2);

    await pool.query(`DELETE FROM dashboards WHERE id = $1`, [dashboardId]);

    const afterCount = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM dashboard_user_drafts WHERE dashboard_id = $1`,
      [dashboardId],
    );
    expect(afterCount.rows[0]?.c).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------
  // proactive_public_dataset (#2297) + extended meter event-type CHECK
  // ---------------------------------------------------------------------------

  it("proactive_public_dataset: round-trip insert + select preserves entity + deny_metrics (#2297)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pd-rt-${stamp}`;

    await pool.query(
      `INSERT INTO proactive_public_dataset (workspace_id, entity_name, deny_metrics)
       VALUES ($1, $2, $3::text[])`,
      [ws, "marketing.users", ["email", "phone_number"]],
    );
    const { rows } = await pool.query<{ entity_name: string; deny_metrics: string[] }>(
      `SELECT entity_name, deny_metrics
         FROM proactive_public_dataset
        WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].entity_name).toBe("marketing.users");
    expect(rows[0].deny_metrics).toEqual(["email", "phone_number"]);
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_public_dataset: unique index rejects duplicate (workspace_id, entity_name) (#2297)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pd-dup-${stamp}`;

    await pool.query(
      `INSERT INTO proactive_public_dataset (workspace_id, entity_name)
       VALUES ($1, $2)`,
      [ws, "marketing.users"],
    );

    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO proactive_public_dataset (workspace_id, entity_name)
         VALUES ($1, $2)`,
        [ws, "marketing.users"],
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/uq_proactive_public_dataset_workspace_entity|duplicate|23505/i);
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_public_dataset: ON CONFLICT updates deny_metrics + updated_at (#2297)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pd-upsert-${stamp}`;

    await pool.query(
      `INSERT INTO proactive_public_dataset (workspace_id, entity_name, deny_metrics)
       VALUES ($1, $2, $3::text[])`,
      [ws, "marketing.users", ["email"]],
    );

    await pool.query(
      `INSERT INTO proactive_public_dataset (workspace_id, entity_name, deny_metrics)
       VALUES ($1, $2, $3::text[])
       ON CONFLICT (workspace_id, entity_name) DO UPDATE
         SET deny_metrics = EXCLUDED.deny_metrics,
             updated_at = NOW()`,
      [ws, "marketing.users", ["email", "phone_number"]],
    );

    const { rows } = await pool.query<{ deny_metrics: string[] }>(
      `SELECT deny_metrics FROM proactive_public_dataset
        WHERE workspace_id = $1 AND entity_name = $2`,
      [ws, "marketing.users"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].deny_metrics).toEqual(["email", "phone_number"]);
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_public_dataset: indexes are created (#2297)", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'proactive_public_dataset'
        ORDER BY indexname`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("uq_proactive_public_dataset_workspace_entity");
    expect(names).toContain("idx_proactive_public_dataset_workspace");
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_meter_events: accepts the new public_refused event_type (#2297)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pr-${stamp}`;

    await pool.query(
      `INSERT INTO proactive_meter_events (workspace_id, channel_id, event_type, metadata)
       VALUES ($1, $2, 'public_refused', $3::jsonb)`,
      [ws, `C-${stamp}`, JSON.stringify({ entityName: "marketing.users" })],
    );
    const { rows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM proactive_meter_events WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("public_refused");
  }, PG_TEST_TIMEOUT_MS);

  it("proactive_meter_events: CHECK still rejects out-of-enum event_type (#2297)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-pr-bad-${stamp}`;
    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO proactive_meter_events (workspace_id, channel_id, event_type)
         VALUES ($1, $2, 'not-a-real-type')`,
        [ws, `C-${stamp}`],
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/chk_proactive_meter_event_type|23514|check constraint/i);
  }, PG_TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------
  // workspace_proactive_config CHECK constraints (#2294, migration 0075).
  // The route layer already validates with zod, but the CHECK is the
  // last-line defence — a direct INSERT bypassing the route must still
  // reject. These three cases exercise each constraint independently.
  // ---------------------------------------------------------------------------

  it("workspace_proactive_config: CHECK rejects invalid sensitivity preset (#2294)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-wpc-sens-${stamp}`;
    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO workspace_proactive_config (workspace_id, sensitivity)
         VALUES ($1, 'reckless')`,
        [ws],
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/chk_workspace_proactive_sensitivity|23514|check constraint/i);
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_proactive_config: CHECK rejects invalid classifier_mode (#2294)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-wpc-mode-${stamp}`;
    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO workspace_proactive_config (workspace_id, classifier_mode)
         VALUES ($1, 'classify-with-vibes')`,
        [ws],
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/chk_workspace_proactive_classifier_mode|23514|check constraint/i);
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_proactive_config: CHECK rejects negative monthly_classifier_cap (#2294)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-wpc-cap-${stamp}`;
    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO workspace_proactive_config (workspace_id, monthly_classifier_cap)
         VALUES ($1, -5)`,
        [ws],
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/chk_workspace_proactive_monthly_cap_nonneg|23514|check constraint/i);
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_proactive_config: CHECK accepts NULL monthly_classifier_cap (unlimited) (#2294)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-wpc-cap-null-${stamp}`;
    await pool.query(
      `INSERT INTO workspace_proactive_config (workspace_id, monthly_classifier_cap)
       VALUES ($1, NULL)`,
      [ws],
    );
    const { rows } = await pool.query<{ monthly_classifier_cap: number | null }>(
      `SELECT monthly_classifier_cap FROM workspace_proactive_config WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].monthly_classifier_cap).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  it("workspace_proactive_config: CHECK rejects empty workspace_id (#2623 item 5, migration 0085)", async () => {
    let err: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO workspace_proactive_config (workspace_id) VALUES ('')`,
      );
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(
      /chk_workspace_proactive_workspace_id_nonempty|23514|check constraint/i,
    );
  }, PG_TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------
  // AnswerMeter end-to-end round-trip (#2296). recordMeterEvent ↔
  // summarizeMeterEvents has only been tested via the pure aggregator
  // until now; this catches:
  //   - param array shape drift in INSERT_SQL
  //   - NUMERIC → number coercion in summarizeMeterEvents
  //   - FK / index / CHECK regressions on round-trip
  //   - quota's COUNT(*) accounting (recordMeterEvent is the quota
  //     usage source-of-truth)
  // ---------------------------------------------------------------------------

  it("answer-meter: proactive_meter_events round-trip schema works as the aggregator expects (#2296)", async () => {
    // Uses raw pool.query rather than `recordMeterEvent` / `summarizeMeterEvents`
    // because those go through `internalQuery`, whose pool isn't wired
    // to this test's schema-scoped pool. The schema-level assertion is
    // what migrate-pg owns; the in-process `recordMeterEvent` plumbing
    // is exercised by the listener/answer-meter unit tests.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-am-rt-${stamp}`;
    const ch = `C-am-rt-${stamp}`;

    const insert = `INSERT INTO proactive_meter_events
      (workspace_id, channel_id, message_id, event_type, outcome, tokens, cost_micro_usd, confidence, actor_user_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`;

    await pool.query(insert, [
      ws, ch, `M-${stamp}-1`, "classify", null, 120, 250, "0.91", null, JSON.stringify({}),
    ]);
    await pool.query(insert, [
      ws, ch, `M-${stamp}-1`, "react", null, 0, 0, "0.91", null, JSON.stringify({}),
    ]);
    await pool.query(insert, [
      ws, ch, null, "feedback", "helpful", 0, 0, null, `U-${stamp}`, JSON.stringify({}),
    ]);
    await pool.query(insert, [
      ws, ch, null, "feedback", "not-helpful", 0, 0, null, `U-${stamp}`, JSON.stringify({}),
    ]);
    await pool.query(insert, [
      ws, ch, null, "public_refused", null, 0, 0, null, null,
      JSON.stringify({ reason: "entity-not-in-allowlist", entityName: "finance.revenue" }),
    ]);

    // Mirrors `summarizeMeterEvents`'s SELECT so we exercise the SAME
    // SQL path (column names + types + ORDER BY) the aggregator depends
    // on — schema drift in any of those would fail loudly here.
    const { rows } = await pool.query<{
      channel_id: string;
      event_type: string;
      outcome: string | null;
      cost_micro_usd: string | number;
    }>(
      `SELECT channel_id, event_type, outcome, cost_micro_usd
         FROM proactive_meter_events
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [ws],
    );
    expect(rows.length).toBe(5);

    const classify = rows.filter((r) => r.event_type === "classify");
    expect(classify.length).toBe(1);
    // Postgres INTEGER columns come back as JS numbers (no NUMERIC
    // coercion needed here — but the round-trip pins the type).
    expect(typeof classify[0]!.cost_micro_usd).toBe("number");
    expect(classify[0]!.cost_micro_usd).toBe(250);

    expect(rows.filter((r) => r.event_type === "react").length).toBe(1);
    expect(
      rows.filter((r) => r.event_type === "feedback" && r.outcome === "helpful").length,
    ).toBe(1);
    expect(
      rows.filter((r) => r.event_type === "feedback" && r.outcome === "not-helpful").length,
    ).toBe(1);
    expect(rows.filter((r) => r.event_type === "public_refused").length).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("answer-meter: COUNT(*) WHERE event_type='classify' is what the quota cap reads (#2301)", async () => {
    // Mirrors `getClassifyCountThisMonth`'s SELECT against raw inserts.
    // Same rationale as the round-trip test above — exercises the SQL
    // path without depending on `internalQuery`'s pool wiring.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-am-quota-${stamp}`;

    const insert = `INSERT INTO proactive_meter_events
      (workspace_id, channel_id, event_type, tokens, metadata)
    VALUES ($1, $2, $3, $4, '{}'::jsonb)`;

    for (let i = 0; i < 3; i++) {
      await pool.query(insert, [ws, `C-${stamp}`, "classify", 80]);
    }
    // Non-classify rows must NOT count against the quota.
    await pool.query(insert, [ws, `C-${stamp}`, "react", 0]);

    const { rows } = await pool.query<{ count: string | number }>(
      `SELECT COUNT(*)::bigint AS count
         FROM proactive_meter_events
        WHERE workspace_id = $1
          AND event_type = 'classify'
          AND created_at >= NOW() - INTERVAL '1 day'`,
      [ws],
    );
    const count = typeof rows[0]!.count === "string" ? Number(rows[0]!.count) : rows[0]!.count;
    expect(count).toBe(3);
  }, PG_TEST_TIMEOUT_MS);

  // PauseRegistry fail-closed posture (#2295 polish) is unit-tested at
  // the listener level (`plugins/chat/src/proactive/__tests__/listener.test.ts`
  // — "treats an isPaused throw as paused (fail CLOSED)" asserts
  // `classify` NOT called and `log.error` called). A real-PG smoke for
  // `isPaused()` was attempted here but requires wiring `_resetPool` to
  // the test pool — that broke 106 unrelated tests because `_resetPool`
  // also nulls the SQL client and resets the circuit breaker. The
  // listener-level assertion is adequate coverage for the fail-closed
  // contract; the SQL schema for `proactive_pauses` itself is exercised
  // by the existing CHECK / index / round-trip tests above.

  // ─────────────────────────────────────────────────────────────────────
  // 0083 — dashboard_stage_changes (#2365)
  //
  // Per-user destructive-op staging on top of the #2364 draft. Four
  // real-PG assertions matter:
  //   1. Column shape — id uuid (default gen_random_uuid), dashboard_id
  //      uuid + FK CASCADE, user_id text, kind/status text, payload jsonb,
  //      timestamps NOT NULL / nullable as appropriate.
  //   2. `kind` CHECK constraint — only `remove_card` / `edit_sql` accepted.
  //   3. `status` CHECK constraint — only `pending` / `applied` /
  //      `discarded` accepted.
  //   4. Terminal-state timestamp invariants — pending forbids both
  //      timestamps; applied requires applied_at + forbids discarded_at;
  //      discarded vice versa.
  //   5. ON DELETE CASCADE — dropping the dashboard drops every stage.
  // ─────────────────────────────────────────────────────────────────────

  it("0080: dashboard_stage_changes column shape — uuid id, FK cascade, text user_id, jsonb payload (#2365)", async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'dashboard_stage_changes'
          AND table_schema = current_schema()
        ORDER BY ordinal_position`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get("id")?.udt_name).toBe("uuid");
    expect(byName.get("id")?.is_nullable).toBe("NO");
    expect(byName.get("dashboard_id")?.udt_name).toBe("uuid");
    expect(byName.get("dashboard_id")?.is_nullable).toBe("NO");
    expect(byName.get("user_id")?.udt_name).toBe("text");
    expect(byName.get("user_id")?.is_nullable).toBe("NO");
    expect(byName.get("kind")?.udt_name).toBe("text");
    expect(byName.get("kind")?.is_nullable).toBe("NO");
    expect(byName.get("payload")?.udt_name).toBe("jsonb");
    expect(byName.get("payload")?.is_nullable).toBe("NO");
    expect(byName.get("status")?.udt_name).toBe("text");
    expect(byName.get("status")?.is_nullable).toBe("NO");
    expect(byName.get("created_at")?.is_nullable).toBe("NO");
    expect(byName.get("updated_at")?.is_nullable).toBe("NO");
    // Terminal-state timestamps are nullable until the row transitions.
    expect(byName.get("applied_at")?.is_nullable).toBe("YES");
    expect(byName.get("discarded_at")?.is_nullable).toBe("YES");
  }, PG_TEST_TIMEOUT_MS);

  it("0080: kind CHECK constraint rejects unknown kinds (#2365)", async () => {
    const stamp = Date.now();
    const orgId = `org-2365-kind-${stamp}`;
    const dashRows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, 'u-2365', 'Kind chk') RETURNING id`,
      [orgId],
    );
    const dashboardId = dashRows.rows[0]?.id as string;

    // Valid kinds succeed.
    await pool.query(
      `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload)
       VALUES ($1, $2, 'remove_card', '{"kind":"remove_card","cardId":"c-1"}'::jsonb)`,
      [dashboardId, `u-2365-${stamp}`],
    );
    await pool.query(
      `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload)
       VALUES ($1, $2, 'edit_sql', '{"kind":"edit_sql","cardId":"c-1","newSql":"SELECT 1","currentSql":"SELECT 0"}'::jsonb)`,
      [dashboardId, `u-2365-${stamp}`],
    );

    // Unknown kind → 23514 (check_violation).
    let chkErr: { code?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload)
         VALUES ($1, $2, 'edit_layout', '{}'::jsonb)`,
        [dashboardId, `u-2365-${stamp}`],
      );
    } catch (err) {
      chkErr = err as { code?: string };
    }
    expect(chkErr?.code).toBe("23514");
  }, PG_TEST_TIMEOUT_MS);

  it("0080: status CHECK + terminal-timestamp invariants (#2365)", async () => {
    const stamp = Date.now();
    const orgId = `org-2365-status-${stamp}`;
    const dashRows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, 'u-2365', 'Status chk') RETURNING id`,
      [orgId],
    );
    const dashboardId = dashRows.rows[0]?.id as string;
    const userId = `u-2365-${stamp}`;

    // pending with both timestamps NULL — succeeds (default).
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload)
       VALUES ($1, $2, 'remove_card', '{"kind":"remove_card","cardId":"c-1"}'::jsonb)
       RETURNING id`,
      [dashboardId, userId],
    );
    const stageId = inserted.rows[0]?.id as string;

    // Flip to applied with applied_at set — succeeds.
    await pool.query(
      `UPDATE dashboard_stage_changes
          SET status = 'applied', applied_at = now()
        WHERE id = $1`,
      [stageId],
    );

    // Trying to mark applied without applied_at — chk violation.
    let bothNullErr: { code?: string } | null = null;
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload)
         VALUES ($1, $2, 'remove_card', '{"kind":"remove_card","cardId":"c-2"}'::jsonb)
         RETURNING id`,
        [dashboardId, userId],
      );
      await pool.query(
        `UPDATE dashboard_stage_changes SET status = 'applied' WHERE id = $1`,
        [r.rows[0]?.id as string],
      );
    } catch (err) {
      bothNullErr = err as { code?: string };
    }
    expect(bothNullErr?.code).toBe("23514");

    // Unknown status → 23514.
    let statusErr: { code?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload, status)
         VALUES ($1, $2, 'remove_card', '{"kind":"remove_card","cardId":"c-3"}'::jsonb, 'rejected')`,
        [dashboardId, userId],
      );
    } catch (err) {
      statusErr = err as { code?: string };
    }
    expect(statusErr?.code).toBe("23514");
  }, PG_TEST_TIMEOUT_MS);

  // #2606 — every integration store renders `installed_at` via the same
  // `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  // formatter so the admin /admin/integrations response satisfies
  // IntegrationStatusSchema's strict `z.string().datetime()`. The bug class
  // (Postgres `::text` default render uses ' ' + '+00', which Zod rejects)
  // was dormant until the first real install row landed in prod. Exercises
  // the formatter against real Postgres; the source-level revert guard
  // lives in the always-on describe block at the bottom of this file.
  it("integration stores: to_char formatter emits strict ISO 8601 that passes z.string().datetime()", async () => {
    const { rows } = await pool.query<{ installed_at: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at`,
    );
    const value = rows[0]?.installed_at;
    expect(typeof value).toBe("string");
    expect(() => z.string().datetime().parse(value)).not.toThrow();
  }, PG_TEST_TIMEOUT_MS);

  it("0080: ON DELETE CASCADE — dropping the parent dashboard drops every stage (#2365)", async () => {
    const stamp = Date.now();
    const orgId = `org-2365-cascade-${stamp}`;
    const dashRows = await pool.query<{ id: string }>(
      `INSERT INTO dashboards (org_id, owner_id, title) VALUES ($1, 'u-2365', 'Cascade test') RETURNING id`,
      [orgId],
    );
    const dashboardId = dashRows.rows[0]?.id as string;
    await pool.query(
      `INSERT INTO dashboard_stage_changes (dashboard_id, user_id, kind, payload)
       VALUES ($1, $2, 'remove_card', '{"kind":"remove_card","cardId":"c-1"}'::jsonb),
              ($1, $3, 'edit_sql', '{"kind":"edit_sql","cardId":"c-2","newSql":"S","currentSql":"S"}'::jsonb)`,
      [dashboardId, `u-2365-a-${stamp}`, `u-2365-b-${stamp}`],
    );
    const beforeCount = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM dashboard_stage_changes WHERE dashboard_id = $1`,
      [dashboardId],
    );
    expect(beforeCount.rows[0]?.c).toBe(2);
    await pool.query(`DELETE FROM dashboards WHERE id = $1`, [dashboardId]);
    const afterCount = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM dashboard_stage_changes WHERE dashboard_id = $1`,
      [dashboardId],
    );
    expect(afterCount.rows[0]?.c).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // 0084 — proactive_classification_review (#2622). The CHECK constraint
  // on `verdict` is the DB-side guard for the misfire-labelling loop;
  // the route's zod schema enforces the same enum but a future direct
  // INSERT (CLI, backfill, migration) bypasses the route. A silent
  // CHECK-drop would let an out-of-enum verdict land here and skew
  // every aggregate the misfire-rate tile computes.
  it("0084: proactive_classification_review CHECK rejects out-of-enum verdict (#2622)", async () => {
    await pool.query(
      `INSERT INTO proactive_classification_review (workspace_id, message_id, verdict)
       VALUES ('ws-1', 'M-1', 'misfire')`,
    );
    await expect(
      pool.query(
        `INSERT INTO proactive_classification_review (workspace_id, message_id, verdict)
         VALUES ('ws-1', 'M-2', 'garbage')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }, PG_TEST_TIMEOUT_MS);

  it("0084: proactive_classification_review composite PK rejects duplicate (workspace_id, message_id) (#2622)", async () => {
    await pool.query(
      `INSERT INTO proactive_classification_review (workspace_id, message_id, verdict)
       VALUES ('ws-pk', 'M-pk', 'correct')`,
    );
    // 23505 = unique_violation; PK enforcement on composite key.
    await expect(
      pool.query(
        `INSERT INTO proactive_classification_review (workspace_id, message_id, verdict)
         VALUES ('ws-pk', 'M-pk', 'unsure')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  }, PG_TEST_TIMEOUT_MS);

  it("0084: proactive_classification_review accepts each of the three verdict values (#2622)", async () => {
    await pool.query(
      `INSERT INTO proactive_classification_review (workspace_id, message_id, verdict)
       VALUES ('ws-enum', 'M-misfire', 'misfire'),
              ('ws-enum', 'M-correct', 'correct'),
              ('ws-enum', 'M-unsure',  'unsure')`,
    );
    const { rows } = await pool.query<{ verdict: string }>(
      `SELECT verdict FROM proactive_classification_review
       WHERE workspace_id = 'ws-enum' ORDER BY message_id`,
    );
    expect(rows.map((r) => r.verdict)).toEqual([
      "correct",
      "misfire",
      "unsure",
    ]);
  }, PG_TEST_TIMEOUT_MS);

  // 0085 — consolidate Slack install storage onto `chat_cache` (#2634).
  // Three things to lock down on a real Postgres:
  //   (1) `slack_installations` is dropped — confirms the migration
  //       actually executes the DROP TABLE.
  //   (2) `chat_cache` exists with the expected shape.
  //   (3) The partial expression index on `value->>'orgId'` (filtered
  //       by the `slack:installation:` key prefix) is created — without
  //       it `getInstallationByOrg` falls back to a full table scan
  //       across every cache row (subscriptions, locks, KV).
  it("0086: drops slack_installations and creates chat_cache + org_id index (#2634)", async () => {
    const { rows: dropped } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'slack_installations'
       ) AS exists`,
    );
    expect(dropped[0]?.exists).toBe(false);

    const { rows: cache } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'chat_cache'
       ) AS exists`,
    );
    expect(cache[0]?.exists).toBe(true);

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'chat_cache'
        ORDER BY indexname`,
    );
    const indexNames = indexes.map((r) => r.indexname);
    expect(indexNames).toContain("idx_chat_cache_slack_org_id");
    expect(indexNames).toContain("idx_chat_cache_expires");
  }, PG_TEST_TIMEOUT_MS);

  it("0086: hijack protection — the upsert WHERE clause rejects a same-team different-org write (#2634)", async () => {
    // Pre-#2634 the legacy `slack_installations` upsert used a
    // `WHERE org_id IS NULL OR org_id = $orgId` clause to refuse
    // rebinding a team to a different org in a single atomic
    // statement. The consolidated path on `chat_cache` mirrors that
    // semantic via `value->>'orgId'`. This test pins the SQL guard
    // against a real Postgres — a refactor that drops the WHERE
    // would let cross-org hijacks through silently.
    const teamId = `T-hijack-${Date.now()}`;
    const key = `slack:installation:${teamId}`;

    // Seed: workspace bound to org-A.
    await pool.query(
      `INSERT INTO chat_cache (key, value) VALUES ($1, $2::jsonb)`,
      [key, JSON.stringify({ botToken: "xoxb-original", orgId: "org-A" })],
    );

    // Attempt the same upsert shape `saveInstallation` uses, but with
    // a different orgId. The WHERE clause must reject it (zero rows
    // returned).
    const hijack = await pool.query(
      `INSERT INTO chat_cache (key, value, expires_at)
       VALUES ($1, $2::jsonb, NULL)
       ON CONFLICT (key) DO UPDATE
         SET value = chat_cache.value || EXCLUDED.value,
             expires_at = NULL
         WHERE chat_cache.value->>'orgId' IS NULL
            OR chat_cache.value->>'orgId' = $3
       RETURNING key`,
      [
        key,
        JSON.stringify({ botToken: "xoxb-hijack", orgId: "org-B" }),
        "org-B",
      ],
    );
    expect(hijack.rows).toHaveLength(0);

    // The original row must survive untouched.
    const { rows } = await pool.query<{ value: { botToken: string; orgId: string } }>(
      `SELECT value FROM chat_cache WHERE key = $1`,
      [key],
    );
    expect(rows[0]?.value.botToken).toBe("xoxb-original");
    expect(rows[0]?.value.orgId).toBe("org-A");
  }, PG_TEST_TIMEOUT_MS);

  it("0086: JSONB merge preserves adapter-extension fields on a re-save (#2634)", async () => {
    // The upsert's `value = chat_cache.value || EXCLUDED.value` merges
    // right-wins-shallow so a future chat-adapter write (e.g.
    // `botUserId` set after an `auth.test` round-trip) survives a
    // re-run of Atlas's `saveInstallation`. A refactor that switched
    // to `value = EXCLUDED.value` (clobber) would silently lose
    // those fields — locked down here.
    const teamId = `T-merge-${Date.now()}`;
    const key = `slack:installation:${teamId}`;

    // Seed an existing row whose value already carries an
    // adapter-supplied field that Atlas's `saveInstallation` does
    // NOT write.
    await pool.query(
      `INSERT INTO chat_cache (key, value) VALUES ($1, $2::jsonb)`,
      [
        key,
        JSON.stringify({
          botToken: "xoxb-initial",
          botUserId: "U-adapter-set",
          orgId: "org-merge",
        }),
      ],
    );

    // Atlas's `saveInstallation` upsert — does NOT include
    // `botUserId`. The merge must keep it.
    await pool.query(
      `INSERT INTO chat_cache (key, value, expires_at)
       VALUES ($1, $2::jsonb, NULL)
       ON CONFLICT (key) DO UPDATE
         SET value = chat_cache.value || EXCLUDED.value,
             expires_at = NULL
         WHERE chat_cache.value->>'orgId' IS NULL
            OR chat_cache.value->>'orgId' = $3
       RETURNING key`,
      [
        key,
        JSON.stringify({ botToken: "xoxb-rotated", orgId: "org-merge" }),
        "org-merge",
      ],
    );

    const { rows } = await pool.query<{
      value: { botToken: string; botUserId?: string; orgId: string };
    }>(`SELECT value FROM chat_cache WHERE key = $1`, [key]);

    expect(rows[0]?.value.botToken).toBe("xoxb-rotated");
    expect(rows[0]?.value.botUserId).toBe("U-adapter-set");
    expect(rows[0]?.value.orgId).toBe("org-merge");
  }, PG_TEST_TIMEOUT_MS);

  // #2650 — slice 2 of 1.5.2. Pins the two new columns + the install_model
  // CHECK so a regression that drops either column or admits a stray value
  // (`oauth2`, `oAuth`, etc.) fails the migrate smoke instead of landing
  // an un-dispatchable catalog row in production.
  it("0087: plugin_catalog.install_model + saas_eligible columns exist and CHECK is enforced", async () => {
    const slug = `pg-smoke-${Date.now()}`;
    const id = `cat-${slug}`;

    // Happy path: insert with the canonical OAuth value + explicit
    // saas_eligible. Defaults are tested by the seeder unit tests; here
    // we just confirm the columns accept the documented enum values.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, install_model, saas_eligible)
       VALUES ($1, 'PG Smoke Catalog Entry', $2, 'chat', 'oauth', true)`,
      [id, slug],
    );

    const { rows } = await pool.query<{
      install_model: string;
      saas_eligible: boolean;
    }>(`SELECT install_model, saas_eligible FROM plugin_catalog WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.install_model).toBe("oauth");
    expect(rows[0]?.saas_eligible).toBe(true);

    // CHECK rejects an unknown install_model with 23514 (check_violation).
    await expect(
      pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, install_model)
         VALUES ($1, 'Should Fail', $2, 'chat', 'not-a-model')`,
        [`${id}-bad`, `${slug}-bad`],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // CHECK also accepts the other two documented values.
    for (const value of ["form", "static-bot"] as const) {
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, install_model)
         VALUES ($1, 'PG Smoke', $2, 'integration', $3)`,
        [`${id}-${value}`, `${slug}-${value}`, value],
      );
    }

    // The widened `type` CHECK admits 'chat' and 'integration' alongside
    // the legacy values. Lock both new values down.
    for (const t of ["chat", "integration"] as const) {
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, install_model)
         VALUES ($1, 'PG Smoke Type', $2, $3, 'oauth')`,
        [`${id}-type-${t}`, `${slug}-type-${t}`, t],
      );
    }
  }, PG_TEST_TIMEOUT_MS);

  // Pinned by PR-test-analyzer review on #2664 — guards the
  // `DEFAULT 'oauth'` / `DEFAULT true` clauses against a future
  // "tidying" revision that drops them. Without defaults, a row that
  // omits the columns lands NULL, which fails the CHECK (install_model)
  // or breaks downstream consumers (saas_eligible).
  it("0087: install_model + saas_eligible defaults apply on omission", async () => {
    const slug = `pg-default-${Date.now()}`;
    const id = `cat-${slug}`;

    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type)
       VALUES ($1, 'PG Default Smoke', $2, 'chat')`,
      [id, slug],
    );

    const { rows } = await pool.query<{
      install_model: string;
      saas_eligible: boolean;
    }>(
      `SELECT install_model, saas_eligible FROM plugin_catalog WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.install_model).toBe("oauth");
    expect(rows[0]?.saas_eligible).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("0086: chat_cache.value->>'orgId' returns the Atlas org id for a stored Slack install (#2634)", async () => {
    // End-to-end shape check: a row written through the consolidated
    // path resolves cleanly by org_id via the new partial index. Uses
    // the chat-adapter's plaintext-bot-token branch (SLACK_ENCRYPTION_KEY
    // unset in CI) so the assertion stays infra-free.
    await pool.query(
      `INSERT INTO chat_cache (key, value)
       VALUES ($1, $2::jsonb)`,
      [
        "slack:installation:T-pg-test",
        JSON.stringify({
          botToken: "xoxb-pg-test",
          orgId: "org-pg-test",
          workspaceName: "PG Test Workspace",
          installedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    );
    const { rows } = await pool.query<{ value: { orgId: string } }>(
      `SELECT value FROM chat_cache
        WHERE key LIKE 'slack:installation:%' AND value->>'orgId' = $1`,
      ["org-pg-test"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value.orgId).toBe("org-pg-test");
  }, PG_TEST_TIMEOUT_MS);

  // #2655 — slice 7 of 1.5.2. Real-PG smoke for the backfill migration.
  // Catches SQL planning errors the mock-based migrate tests can't (the
  // CTE-free INSERT…SELECT path, the JSON `->>'orgId'` extraction, the
  // ON CONFLICT clause on the composite unique index). Also asserts
  // idempotency at the real PG layer — re-running the migration set
  // must not duplicate rows.
  //
  // Tests load the migration's actual SQL via `readFileSync` and execute
  // it verbatim — drift in the file (column rename, ON CONFLICT typo,
  // wrong substring offset) fails the smoke instead of silently passing
  // a hand-rolled copy. Pinned by pr-test-analyzer review on #2692.
  describe("0088: backfill workspace_plugins from chat_cache (#2655)", () => {
    const migration0088Sql = readFileSync(
      join(
        import.meta.dir,
        "..",
        "migrations",
        "0088_backfill_workspace_plugins.sql",
      ),
      "utf-8",
    );

    it("inserts workspace_plugins rows for chat_cache:slack:installation rows with non-empty orgId", async () => {
      const ws = "org-backfill-smoke";
      const team = `T-backfill-${Date.now()}`;
      // Write a chat_cache row in the post-#2634 consolidated shape.
      await pool.query(
        `INSERT INTO chat_cache (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          `slack:installation:${team}`,
          JSON.stringify({
            botToken: "xoxb-backfill-smoke",
            orgId: ws,
            workspaceName: "Backfill Smoke",
            installedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      );
      // Re-execute the migration's actual SQL verbatim. The migration
      // runner already replayed it at beforeAll (so `catalog:slack` row
      // exists); this run picks up the new chat_cache row via the
      // INSERT…SELECT sweep.
      await pool.query(migration0088Sql);
      const { rows: after } = await pool.query<{
        catalog_id: string;
        config: { team_id: string; backfilled_from: string };
      }>(
        `SELECT wp.catalog_id, wp.config
           FROM workspace_plugins wp
           JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE pc.slug = 'slack' AND wp.workspace_id = $1
          LIMIT 1`,
        [ws],
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.config.team_id).toBe(team);
      expect(after[0]?.config.backfilled_from).toBe("chat_cache (migration 0088)");
    }, PG_TEST_TIMEOUT_MS);

    it("resolves catalog_id via slug JOIN, not the literal 'catalog:slack' string (Codex P1)", async () => {
      // Codex flagged on #2692: if `plugin_catalog` already carried a
      // `slug='slack'` row with a non-`catalog:slack` id (admin-marketplace
      // mints UUIDs via `crypto.randomUUID()`), the migration's
      // `ON CONFLICT (slug) DO NOTHING` keeps the legacy id, and a
      // hard-coded `'catalog:slack'` FK target would abort with a
      // foreign-key violation. Pinning the slug-JOIN posture here.
      const customCatalogId = `cat-custom-${Date.now()}`;
      const customSlug = `custom-slack-${Date.now()}`;
      const ws = `org-custom-${Date.now()}`;
      const team = `T-custom-${Date.now()}`;

      // Pre-seed plugin_catalog with a non-canonical id but slug=custom-slack.
      // (Using a non-'slack' slug so we don't disturb the dogfood catalog row.)
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, install_model, enabled)
         VALUES ($1, 'Custom Slack', $2, 'chat', 'oauth', true)`,
        [customCatalogId, customSlug],
      );
      await pool.query(
        `INSERT INTO chat_cache (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          `slack:installation:${team}`,
          JSON.stringify({ botToken: "xoxb-custom", orgId: ws }),
        ],
      );
      // Run the equivalent slug-JOIN INSERT against the custom slug.
      // Demonstrates the JOIN pattern is robust to non-canonical
      // catalog ids — exactly what the Codex P1 fix protects against.
      await pool.query(
        `INSERT INTO workspace_plugins
          (id, workspace_id, catalog_id, config, enabled, installed_at)
         SELECT
           gen_random_uuid()::text,
           cc.value ->> 'orgId',
           pc.id,
           jsonb_build_object('team_id', substring(cc.key FROM length('slack:installation:') + 1)),
           true,
           NOW()
         FROM chat_cache cc
         JOIN plugin_catalog pc ON pc.slug = $2
         WHERE cc.key LIKE 'slack:installation:%'
           AND cc.value ->> 'orgId' = $1
         ON CONFLICT (workspace_id, catalog_id) DO NOTHING`,
        [ws, customSlug],
      );
      const { rows } = await pool.query<{ catalog_id: string }>(
        `SELECT catalog_id FROM workspace_plugins WHERE workspace_id = $1`,
        [ws],
      );
      // FK resolved against the pre-seeded id, not 'catalog:custom-slack'.
      expect(rows[0]?.catalog_id).toBe(customCatalogId);
    }, PG_TEST_TIMEOUT_MS);

    it("is idempotent — re-running the migration SQL does not duplicate", async () => {
      const ws = "org-backfill-idempotent";
      const team = `T-idem-${Date.now()}`;
      await pool.query(
        `INSERT INTO chat_cache (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          `slack:installation:${team}`,
          JSON.stringify({ botToken: "xoxb-idem", orgId: ws }),
        ],
      );
      await pool.query(migration0088Sql);
      await pool.query(migration0088Sql);
      await pool.query(migration0088Sql);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM workspace_plugins wp
           JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE pc.slug = 'slack' AND wp.workspace_id = $1`,
        [ws],
      );
      // Three runs, one row — the composite unique index does the job.
      expect(rows[0]?.n).toBe("1");
    }, PG_TEST_TIMEOUT_MS);

    it("skips chat_cache rows with NULL or empty orgId (no FK-less workspace_plugins rows)", async () => {
      const team = `T-noorg-${Date.now()}`;
      await pool.query(
        `INSERT INTO chat_cache (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          `slack:installation:${team}`,
          // No orgId at all.
          JSON.stringify({ botToken: "xoxb-noorg" }),
        ],
      );
      // Run the migration's actual SQL — it sweeps every chat_cache
      // installation row, so this exercises the WHERE-filter against
      // a real orgId-less row sitting in the table.
      await pool.query(migration0088Sql);
      const after = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM workspace_plugins wp
           JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE pc.slug = 'slack' AND wp.config ->> 'team_id' = $1`,
        [team],
      );
      // Orphan row was orgId-less → migration's WHERE clause filtered
      // it out, so no workspace_plugins row carries our team_id.
      expect(after.rows[0]?.n).toBe("0");
    }, PG_TEST_TIMEOUT_MS);
  });

  // 0092 / #2739 — three-pillar taxonomy + install_id foundation.
  // Schema-only slice: callers under integrations/install/*-handler.ts
  // continue to omit `pillar` and `install_id`; two BEFORE INSERT
  // triggers fill them in. These tests pin trigger fill (both tables),
  // trigger non-clobber, CHECK enforcement (both pillar columns +
  // implementation_status), defaults-on-omission, the composite PK,
  // the partial unique singleton, the preserved `id` uniqueness, the
  // diagnostic 23503 the workspace trigger raises on orphan catalog_id,
  // and the prod-critical backfill regression — the prior-art "fresh
  // self-host upgrade" path subsequent slices depend on.
  describe("0092: pillar + install_id columns (#2739, 1.5.3 slice 1)", () => {
    it("plugin_catalog: new columns + CHECK constraints are enforced (pillar, implementation_status)", async () => {
      const slug = `pg-0092-${Date.now()}`;
      const id = `cat-${slug}`;

      // Insert with all three new columns explicit — exercises that the
      // columns exist with the documented types and that explicit values
      // round-trip (no SELECT pillar/implementation_status/auto_install
      // semantics happen in production code yet — slice 3+ wire reads).
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, implementation_status, auto_install)
         VALUES ($1, '0092 Smoke', $2, 'integration', 'action', 'available', false)`,
        [id, slug],
      );

      const { rows } = await pool.query<{
        pillar: string;
        implementation_status: string;
        auto_install: boolean;
      }>(
        `SELECT pillar, implementation_status, auto_install FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.pillar).toBe("action");
      expect(rows[0]?.implementation_status).toBe("available");
      expect(rows[0]?.auto_install).toBe(false);

      // CHECK rejects unknown pillar with 23514.
      await expect(
        pool.query(
          `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
           VALUES ($1, 'Bad Pillar', $2, 'chat', 'something-else')`,
          [`${id}-bad-pillar`, `${slug}-bad-pillar`],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      // CHECK rejects unknown implementation_status with 23514.
      await expect(
        pool.query(
          `INSERT INTO plugin_catalog (id, name, slug, type, pillar, implementation_status)
           VALUES ($1, 'Bad Status', $2, 'chat', 'chat', 'totally-shipped')`,
          [`${id}-bad-status`, `${slug}-bad-status`],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }, PG_TEST_TIMEOUT_MS);

    it("plugin_catalog: trigger derives pillar from type (chat/datasource/integration) when caller omits pillar", async () => {
      // Three call sites today (admin-marketplace.ts, catalog-seeder.ts,
      // migration 0088) INSERT plugin_catalog rows without naming
      // pillar. Trigger must map type → pillar correctly for each.
      const slug = `pg-0092-cat-trig-${Date.now()}`;

      type Row = { pillar: string };
      const cases: Array<{ type: string; expected: string }> = [
        { type: "chat", expected: "chat" },
        { type: "datasource", expected: "datasource" },
        { type: "integration", expected: "action" },
        { type: "action", expected: "action" },
      ];

      for (const { type, expected } of cases) {
        const id = `cat-${slug}-${type}`;
        await pool.query(
          `INSERT INTO plugin_catalog (id, name, slug, type) VALUES ($1, '0092 Trigger', $2, $3)`,
          [id, `${slug}-${type}`, type],
        );
        const { rows } = await pool.query<Row>(
          `SELECT pillar FROM plugin_catalog WHERE id = $1`,
          [id],
        );
        expect(rows[0]?.pillar).toBe(expected);
      }
    }, PG_TEST_TIMEOUT_MS);

    it("plugin_catalog: trigger does NOT clobber caller-provided pillar", async () => {
      // Load-bearing for slice 5 (#2743): once built-in Datasource
      // catalog rows are seeded with explicit pillar, a future
      // "simplification" that drops the `IF NEW.pillar IS NULL` guard
      // would silently rewrite their pillar from the CASE expression
      // (e.g. a `type='datasource', pillar='datasource'` row stays at
      // datasource — but a future `type='custom', pillar='chat'` row
      // would silently get rewritten to 'action').
      const slug = `pg-0092-cat-noclobber-${Date.now()}`;
      const id = `cat-${slug}`;
      // type='datasource' would auto-derive pillar='datasource'; we
      // pass pillar='chat' explicitly to prove the guard holds even
      // when the CASE would produce a different value.
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 No-Clobber', $2, 'datasource', 'chat')`,
        [id, slug],
      );
      const { rows } = await pool.query<{ pillar: string }>(
        `SELECT pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.pillar).toBe("chat");
    }, PG_TEST_TIMEOUT_MS);

    it("plugin_catalog: BEFORE UPDATE trigger re-derives pillar when type changes (UPDATE without naming pillar)", async () => {
      // Codex P1 on PR #2756: catalog-seeder upsert (`SET type =
      // EXCLUDED.type`) and admin marketplace PATCH both UPDATE type
      // on existing rows. Without the UPDATE trigger, pillar drifts
      // and the workspace_plugins INSERT trigger propagates the stale
      // value.
      const slug = `pg-0092-cat-update-${Date.now()}`;
      const id = `cat-${slug}`;

      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type) VALUES ($1, '0092 Update Trigger', $2, 'chat')`,
        [id, slug],
      );
      // INSERT trigger derives pillar='chat' from type='chat'.
      let { rows } = await pool.query<{ pillar: string }>(
        `SELECT pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.pillar).toBe("chat");

      // Update type only — UPDATE trigger re-derives pillar.
      await pool.query(
        `UPDATE plugin_catalog SET type = 'datasource' WHERE id = $1`,
        [id],
      );
      ({ rows } = await pool.query<{ pillar: string }>(
        `SELECT pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      ));
      expect(rows[0]?.pillar).toBe("datasource");

      // Update type from datasource → integration — pillar follows
      // to 'action'.
      await pool.query(
        `UPDATE plugin_catalog SET type = 'integration' WHERE id = $1`,
        [id],
      );
      ({ rows } = await pool.query<{ pillar: string }>(
        `SELECT pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      ));
      expect(rows[0]?.pillar).toBe("action");
    }, PG_TEST_TIMEOUT_MS);

    it("plugin_catalog: BEFORE UPDATE trigger does NOT clobber when caller updates both type AND pillar", async () => {
      // Same UPDATE statement names both columns to different values:
      // the explicit pillar wins. Locks the `IS NOT DISTINCT FROM`
      // guard against a future revision that drops it.
      const slug = `pg-0092-cat-update-noclobber-${Date.now()}`;
      const id = `cat-${slug}`;

      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar) VALUES ($1, '0092 Update No-Clobber', $2, 'chat', 'chat')`,
        [id, slug],
      );

      // Update type='datasource' would normally derive pillar='datasource';
      // caller explicitly says pillar='action' — explicit wins.
      await pool.query(
        `UPDATE plugin_catalog SET type = 'datasource', pillar = 'action' WHERE id = $1`,
        [id],
      );
      const { rows } = await pool.query<{ type: string; pillar: string }>(
        `SELECT type, pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.type).toBe("datasource");
      expect(rows[0]?.pillar).toBe("action");
    }, PG_TEST_TIMEOUT_MS);

    it("plugin_catalog: BEFORE UPDATE trigger leaves pillar alone when only unrelated columns change", async () => {
      // Updating description/enabled/etc. must not touch pillar — the
      // trigger guard `NEW.type IS DISTINCT FROM OLD.type` short-
      // circuits when type didn't change.
      const slug = `pg-0092-cat-update-unrelated-${Date.now()}`;
      const id = `cat-${slug}`;

      // Insert with explicit non-trigger-mapped pillar (chat for a
      // datasource-typed row) so a stray "re-derive on every update"
      // would visibly rewrite to 'datasource'.
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar) VALUES ($1, '0092 Update Untouched', $2, 'datasource', 'chat')`,
        [id, slug],
      );

      await pool.query(
        `UPDATE plugin_catalog SET description = 'updated description' WHERE id = $1`,
        [id],
      );
      const { rows } = await pool.query<{ pillar: string }>(
        `SELECT pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.pillar).toBe("chat");
    }, PG_TEST_TIMEOUT_MS);

    it("plugin_catalog: implementation_status + auto_install defaults apply on omission", async () => {
      // Pinned by silent-failure review on #2756 — guards the
      // `DEFAULT 'available'` / `DEFAULT false` clauses against a
      // future revision that drops them. Without defaults, a row that
      // omits the columns lands NULL, which fails the
      // implementation_status CHECK (23514).
      const slug = `pg-0092-cat-defaults-${Date.now()}`;
      const id = `cat-${slug}`;
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type) VALUES ($1, '0092 Defaults', $2, 'integration')`,
        [id, slug],
      );
      const { rows } = await pool.query<{
        implementation_status: string;
        auto_install: boolean;
      }>(
        `SELECT implementation_status, auto_install FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.implementation_status).toBe("available");
      expect(rows[0]?.auto_install).toBe(false);
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: BEFORE INSERT trigger fills install_id + pillar when caller omits them", async () => {
      // Seed a catalog row whose pillar will flow through the trigger.
      const slug = `pg-0092-trig-${Date.now()}`;
      const catalogId = `cat-${slug}`;
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 Trigger Smoke', $2, 'chat', 'chat')`,
        [catalogId, slug],
      );

      // Mimic the existing handler INSERT shape (no install_id, no
      // pillar). Trigger fills both.
      const installId = `wp-${slug}`;
      const workspaceId = `ws-${slug}`;
      await pool.query(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, true, NOW())`,
        [installId, workspaceId, catalogId],
      );

      const { rows } = await pool.query<{
        install_id: string;
        pillar: string;
      }>(
        `SELECT install_id, pillar FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = $2`,
        [workspaceId, catalogId],
      );
      expect(rows[0]?.install_id).toBe(catalogId);
      expect(rows[0]?.pillar).toBe("chat");
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: partial unique 'workspace_plugins_singleton' blocks a second chat install for the same (workspace, catalog)", async () => {
      const slug = `pg-0092-uniq-${Date.now()}`;
      const catalogId = `cat-${slug}`;
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 Unique Smoke', $2, 'chat', 'chat')`,
        [catalogId, slug],
      );

      const workspaceId = `ws-${slug}`;
      await pool.query(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, true, NOW())`,
        [`first-${slug}`, workspaceId, catalogId],
      );

      // Second insert for the same (workspace, catalog) — different `id`
      // and `install_id` — should still be blocked. The pre-existing
      // `idx_workspace_plugins_unique` would catch it too in this slice,
      // but the partial unique is the post-1.5.3 invariant that survives
      // slice 5/6's global-unique drop. Either way: 23505.
      await expect(
        pool.query(
          `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
           VALUES ($1, $2, $3, $4, 'chat', '{}'::jsonb, true, NOW())`,
          [`second-${slug}`, workspaceId, catalogId, `second-install-${slug}`],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: composite PK rejects an exact (workspace, catalog, install) duplicate even across pillars", async () => {
      const slug = `pg-0092-pk-${Date.now()}`;
      const catalogId = `cat-${slug}`;
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 PK Smoke', $2, 'integration', 'action')`,
        [catalogId, slug],
      );

      const workspaceId = `ws-${slug}`;
      const installId = `inst-${slug}`;

      await pool.query(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4, 'action', '{}'::jsonb, true, NOW())`,
        [`first-${slug}`, workspaceId, catalogId, installId],
      );

      await expect(
        pool.query(
          `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
           VALUES ($1, $2, $3, $4, 'action', '{}'::jsonb, true, NOW())`,
          [`second-${slug}`, workspaceId, catalogId, installId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: `id` uniqueness preserved after PK swap", async () => {
      // The dropped single-column PK used to enforce id uniqueness;
      // `workspace_plugins_id_unique` takes over. Reuse the same id
      // across two distinct (workspace, catalog) pairs and confirm
      // the second insert rejects with 23505.
      const slug = `pg-0092-id-${Date.now()}`;
      const catalogIdA = `cat-a-${slug}`;
      const catalogIdB = `cat-b-${slug}`;
      const sharedId = `shared-${slug}`;

      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 ID Smoke A', $2, 'chat', 'chat'),
                ($3, '0092 ID Smoke B', $4, 'chat', 'chat')`,
        [catalogIdA, `${slug}-a`, catalogIdB, `${slug}-b`],
      );

      await pool.query(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, true, NOW())`,
        [sharedId, `ws-${slug}`, catalogIdA],
      );

      await expect(
        pool.query(
          `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
           VALUES ($1, $2, $3, '{}'::jsonb, true, NOW())`,
          [sharedId, `ws-${slug}`, catalogIdB],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: trigger does NOT clobber caller-provided install_id + pillar", async () => {
      // Slice 4 (WorkspaceInstaller, #2742) will explicitly name both
      // columns. The `IF NEW.x IS NULL` guards are load-bearing then —
      // a "simplification" that drops them would silently rewrite the
      // explicit values from the catalog lookup / sentinel.
      const slug = `pg-0092-wp-noclobber-${Date.now()}`;
      const catalogId = `cat-${slug}`;
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 No-Clobber', $2, 'integration', 'action')`,
        [catalogId, slug],
      );

      const explicitInstallId = `prod-us-${slug}`;
      const workspaceId = `ws-${slug}`;
      // Caller passes pillar='datasource' even though catalog says
      // 'action' — proves the trigger doesn't second-guess explicit
      // values via its catalog SELECT.
      await pool.query(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4, 'datasource', '{}'::jsonb, true, NOW())`,
        [`wp-${slug}`, workspaceId, catalogId, explicitInstallId],
      );

      const { rows } = await pool.query<{ install_id: string; pillar: string }>(
        `SELECT install_id, pillar FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = $2`,
        [workspaceId, catalogId],
      );
      expect(rows[0]?.install_id).toBe(explicitInstallId);
      expect(rows[0]?.pillar).toBe("datasource");
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: chk_workspace_plugins_pillar rejects unknown pillar with 23514", async () => {
      // Separate constraint from `chk_plugin_catalog_pillar` — a
      // missing `ADD CONSTRAINT chk_workspace_plugins_pillar` in the
      // migration would only surface on the catalog side without this
      // test.
      const slug = `pg-0092-wp-check-${Date.now()}`;
      const catalogId = `cat-${slug}`;
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
         VALUES ($1, '0092 Pillar Check', $2, 'integration', 'action')`,
        [catalogId, slug],
      );
      await expect(
        pool.query(
          `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
           VALUES ($1, $2, $3, $4, 'something-else', '{}'::jsonb, true, NOW())`,
          [`wp-${slug}`, `ws-${slug}`, catalogId, `inst-${slug}`],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: backfill UPDATEs assign sentinel install_id + joined pillar for pre-existing NULL rows", async () => {
      // Prod-critical regression: a self-host upgrade with live rows
      // walks through ADD COLUMN (NULL on existing rows) → UPDATE
      // backfill → SET NOT NULL. The full migration has already run
      // in beforeAll, so we simulate the pre-backfill state inside a
      // transaction: drop the NOT NULLs, disable the trigger so we
      // can insert NULLs, replay the migration's UPDATE statements,
      // assert. Postgres DDL is transactional — ROLLBACK reverts every
      // change so subsequent tests see the unchanged shape.
      const slug = `pg-0092-backfill-${Date.now()}`;
      const catalogId = `cat-${slug}`;
      const workspaceId = `ws-${slug}`;
      const installRowId = `wp-${slug}`;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Mimic the post-ADD-COLUMN, pre-UPDATE state of the live
        // migration:
        //   1. Drop the composite PK so install_id can lose its
        //      implicit NOT NULL (PK columns can't be nullable).
        //   2. Drop the explicit NOT NULLs on pillar + install_id.
        //   3. Disable the BEFORE INSERT triggers so we can stage
        //      NULL rows.
        // Postgres DDL is transactional — ROLLBACK reverts every
        // change so subsequent tests see the unchanged shape.
        await client.query(
          `ALTER TABLE workspace_plugins DROP CONSTRAINT workspace_plugins_pkey`,
        );
        await client.query(
          `ALTER TABLE plugin_catalog ALTER COLUMN pillar DROP NOT NULL`,
        );
        await client.query(
          `ALTER TABLE workspace_plugins ALTER COLUMN pillar DROP NOT NULL`,
        );
        await client.query(
          `ALTER TABLE workspace_plugins ALTER COLUMN install_id DROP NOT NULL`,
        );
        await client.query(
          `ALTER TABLE plugin_catalog DISABLE TRIGGER trg_plugin_catalog_default_pillar`,
        );
        await client.query(
          `ALTER TABLE workspace_plugins DISABLE TRIGGER trg_workspace_plugins_default_pillar_install_id`,
        );

        await client.query(
          `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
           VALUES ($1, '0092 Backfill', $2, 'chat', NULL)`,
          [catalogId, slug],
        );
        await client.query(
          `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
           VALUES ($1, $2, $3, NULL, NULL, '{}'::jsonb, true, NOW())`,
          [installRowId, workspaceId, catalogId],
        );

        // Replay the migration's backfill — three plugin_catalog
        // UPDATEs, then the workspace_plugins UPDATE that sets
        // install_id = catalog_id sentinel, then the join that sets
        // workspace_plugins.pillar from the now-populated catalog.
        await client.query(
          `UPDATE plugin_catalog SET pillar = 'chat'       WHERE pillar IS NULL AND type = 'chat'`,
        );
        await client.query(
          `UPDATE plugin_catalog SET pillar = 'datasource' WHERE pillar IS NULL AND type = 'datasource'`,
        );
        await client.query(
          `UPDATE plugin_catalog SET pillar = 'action'     WHERE pillar IS NULL`,
        );
        await client.query(
          `UPDATE workspace_plugins SET install_id = catalog_id WHERE install_id IS NULL`,
        );
        await client.query(
          `UPDATE workspace_plugins wp SET pillar = pc.pillar FROM plugin_catalog pc WHERE pc.id = wp.catalog_id AND wp.pillar IS NULL`,
        );

        const { rows } = await client.query<{
          install_id: string;
          pillar: string;
        }>(
          `SELECT install_id, pillar FROM workspace_plugins WHERE id = $1`,
          [installRowId],
        );
        expect(rows[0]?.install_id).toBe(catalogId);
        expect(rows[0]?.pillar).toBe("chat");

        const { rows: catRows } = await client.query<{ pillar: string }>(
          `SELECT pillar FROM plugin_catalog WHERE id = $1`,
          [catalogId],
        );
        expect(catRows[0]?.pillar).toBe("chat");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins: orphan catalog_id surfaces 23503 from the trigger, not 23502 from NOT NULL", async () => {
      // The trigger raises a FK-style 23503 with a diagnostic message
      // naming the missing catalog_id, instead of letting the row fall
      // through to a confusing `NULL value in column "pillar"` NOT NULL
      // violation. The real FK normally prevents this path; the trigger
      // is a belt-and-braces diagnostic. To exercise it we drop the FK
      // inside a transaction and roll back — works without superuser
      // (unlike SET session_replication_role).
      const slug = `pg-0092-orphan-${Date.now()}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `ALTER TABLE workspace_plugins DROP CONSTRAINT workspace_plugins_catalog_id_fkey`,
        );
        await expect(
          client.query(
            `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
             VALUES ($1, $2, $3, '{}'::jsonb, true, NOW())`,
            [`wp-${slug}`, `ws-${slug}`, `does-not-exist-${slug}`],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }, PG_TEST_TIMEOUT_MS);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 0096: connections / connection_groups cutover (#2744, 1.5.3 slice 6)
  // ─────────────────────────────────────────────────────────────────────
  //
  // Confirms that after the full migration set runs, both legacy tables
  // are gone and `workspace_plugins` carries the new `status` column and
  // the demo `auto_install` per-workspace backfill. Pins the SQL-level
  // invariants the runtime ConnectionRegistry depends on.
  //
  // The legacy `connection_groups` + `connections` describe blocks that
  // used to live earlier in this file were removed in #2744 step 5 —
  // they referenced tables that 0096 drops and now exist only as the
  // assertions below.
  describe("0096: connections / connection_groups cutover (#2744, 1.5.3 slice 6)", () => {
    it("drops both legacy tables", async () => {
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN ('connections', 'connection_groups')`,
      );
      expect(tables.rows.length).toBe(0);
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins.updated_at column exists for content-mode promote SQL", async () => {
      const cols = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'workspace_plugins'
            AND column_name = 'updated_at'`,
      );
      expect(cols.rows).toHaveLength(1);
      expect(cols.rows[0].is_nullable).toBe("NO");
    }, PG_TEST_TIMEOUT_MS);

    it("workspace_plugins.status column exists with the expected CHECK + index", async () => {
      const cols = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'workspace_plugins'
            AND column_name = 'status'`,
      );
      expect(cols.rows).toHaveLength(1);
      expect(cols.rows[0].is_nullable).toBe("NO");
      expect(cols.rows[0].column_default).toContain("published");

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'workspace_plugins'
            AND indexname = 'idx_workspace_plugins_status'`,
      );
      expect(indexes.rows).toHaveLength(1);
    }, PG_TEST_TIMEOUT_MS);

    it("drops the legacy global unique on (workspace_id, catalog_id) — datasource installs are multi-instance", async () => {
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'workspace_plugins'
            AND indexname IN ('idx_workspace_plugins_unique', 'workspace_plugins_workspace_id_catalog_id_key')`,
      );
      expect(indexes.rows).toHaveLength(0);

      // The pillar-aware partial unique survives.
      const singleton = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'workspace_plugins'
            AND indexname = 'workspace_plugins_singleton'`,
      );
      expect(singleton.rows).toHaveLength(1);
    }, PG_TEST_TIMEOUT_MS);

    it("drops the 0092 back-compat triggers + functions", async () => {
      const triggers = await pool.query<{ trigger_name: string }>(
        `SELECT trigger_name FROM information_schema.triggers
          WHERE event_object_schema = current_schema()
            AND trigger_name IN (
              'trg_workspace_plugins_default_pillar_install_id',
              'trg_plugin_catalog_default_pillar',
              'trg_plugin_catalog_sync_pillar_on_type_change'
            )`,
      );
      expect(triggers.rows).toHaveLength(0);
    }, PG_TEST_TIMEOUT_MS);

    it("drops the scheduled_tasks + approval_queue FKs to connection_groups", async () => {
      const fks = await pool.query<{ constraint_name: string }>(
        `SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_schema = current_schema()
            AND constraint_name IN ('fk_scheduled_tasks_group', 'fk_approval_queue_group')`,
      );
      expect(fks.rows).toHaveLength(0);

      // The columns themselves remain as free-form text identifiers
      // (no DB FK) per the pure-(a) connection_groups disposition.
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND ((table_name = 'scheduled_tasks' AND column_name = 'connection_group_id')
              OR (table_name = 'approval_queue' AND column_name = 'connection_group_id'))`,
      );
      expect(cols.rows).toHaveLength(2);
    }, PG_TEST_TIMEOUT_MS);

    // The end-to-end backfill assertion (real `connections` row → matching
    // `workspace_plugins` config blob with bit-exact URL ciphertext)
    // can't run here because by the time the migration set replays, the
    // `connections` table is already gone — so the source data is
    // unobservable. The fail-loud `DO $$` guard inside 0096.sql is the
    // in-migration assertion of "every row produced an output"; an
    // additional integration test against a pre-0096 snapshot DB is
    // tracked as a follow-up.
  });
});

// #2606 — source-level revert guard for the integration-store SQL formatter.
// Lives outside `describeIfPg` so it runs in every shard, including dev
// without TEST_DATABASE_URL — fails in milliseconds if any store reverts
// to `installed_at::text` (the format Zod's strict .datetime() rejects).
describe("integration stores: ISO timestamp SQL", () => {
  it("no store reintroduces installed_at::text", () => {
    const platforms = ["discord", "email", "gchat", "github", "linear", "slack", "teams", "telegram", "whatsapp"] as const;
    for (const platform of platforms) {
      const source = readFileSync(join(import.meta.dir, "..", "..", platform, "store.ts"), "utf8");
      expect(source).not.toContain("installed_at::text");
    }
  });
});
