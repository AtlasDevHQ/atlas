import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { buildStaleCatalogQuery } from "@atlas/api/lib/scheduler/byot-catalog-query";
import {
  RUNNING_UPSERT_SQL,
  TERMINAL_UPSERT_SQL,
  RESUME_CLAIM_SQL,
  PARKED_UPSERT_SQL,
  PARKED_SWEEP_SQL,
  PARKED_RESOLVE_SQL,
} from "@atlas/api/lib/durable-session";
import {
  SESSION_MEMORY_UPSERT_SQL,
  SESSION_MEMORY_SWEEP_SQL,
} from "@atlas/api/lib/durable-state";

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

  it("workspace_proactive_config: CHECK accepts NULL monthly_classifier_cap (no override — plan-tier default since #3436) (#2294)", async () => {
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
  // Post-#2744 the 0092 BEFORE INSERT trigger that filled pillar is gone
  // (dropped by 0096 step 7), so every plugin_catalog INSERT must now
  // name `pillar` explicitly. The 0087 column-existence + CHECK
  // assertions stay relevant; we just thread pillar through.
  it("0087: plugin_catalog.install_model + saas_eligible columns exist and CHECK is enforced", async () => {
    const slug = `pg-smoke-${Date.now()}`;
    const id = `cat-${slug}`;

    // Happy path: insert with the canonical OAuth value + explicit
    // saas_eligible. Defaults are tested by the seeder unit tests; here
    // we just confirm the columns accept the documented enum values.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model, saas_eligible)
       VALUES ($1, 'PG Smoke Catalog Entry', $2, 'chat', 'chat', 'oauth', true)`,
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
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES ($1, 'Should Fail', $2, 'chat', 'chat', 'not-a-model')`,
        [`${id}-bad`, `${slug}-bad`],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // CHECK also accepts the other two documented values.
    for (const value of ["form", "static-bot"] as const) {
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES ($1, 'PG Smoke', $2, 'integration', 'action', $3)`,
        [`${id}-${value}`, `${slug}-${value}`, value],
      );
    }

    // The widened `type` CHECK admits 'chat' and 'integration' alongside
    // the legacy values. Lock both new values down — pillar mirrors type
    // here so the test fixture is faithful to the production catalog seed.
    for (const [t, pillar] of [
      ["chat", "chat"],
      ["integration", "action"],
    ] as const) {
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES ($1, 'PG Smoke Type', $2, $3, $4, 'oauth')`,
        [`${id}-type-${t}`, `${slug}-type-${t}`, t, pillar],
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

    // Post-#2744 the pillar trigger is gone — must name pillar explicitly.
    // The 0087 defaults under test (install_model + saas_eligible) are
    // orthogonal: they still default cleanly when the caller omits them.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
       VALUES ($1, 'PG Default Smoke', $2, 'chat', 'chat')`,
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

  // #3301 — end-to-end: 0093 seeds the built-in DuckDB row `saas_eligible =
  // true`, 0124 converges it to `false`. After the full migration chain (run
  // in beforeAll) the canonical `catalog:duckdb` row must be `false` while a
  // sibling datasource row (postgres) stays `true`. Catches a 0124 that
  // mis-targets the row or never runs.
  it("0124: built-in DuckDB catalog row is saas_eligible = false after migrations (#3301)", async () => {
    const { rows } = await pool.query<{ slug: string; saas_eligible: boolean }>(
      `SELECT slug, saas_eligible FROM plugin_catalog WHERE slug IN ('duckdb', 'postgres') ORDER BY slug`,
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r.saas_eligible]));
    expect(bySlug.get("duckdb")).toBe(false);
    // Sibling datasource rows are untouched — only DuckDB is gated off SaaS.
    expect(bySlug.get("postgres")).toBe(true);
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
  // 0088 backfill describe removed in #2786 (post-#2744 cleanup).
  //
  // The block re-executed migration 0088's actual SQL via `readFileSync`
  // to assert idempotency + slug-JOIN robustness. The replay path stops
  // working post-0096: 0088 INSERTs `workspace_plugins` without naming
  // `pillar` / `install_id` and relied on 0092's BEFORE INSERT trigger
  // to fill them. 0096 step 7 drops the trigger, so re-running 0088
  // against the post-0096 schema fails with 23502 on `pillar`. The
  // production migration chain still runs 0088 once at the right point
  // (between 0092 trigger creation and 0096 trigger drop), and the
  // migration smoke at `beforeAll` covers that end-to-end. Post-cutover
  // invariants (workspace_plugins shape, status column, demo per-workspace
  // backfill) live in the `0096: cutover` describe at the bottom of
  // this file.
  //
  // 0092 pillar+install_id describe also removed in #2786. It asserted:
  //   (a) trigger-derived `pillar` defaulting on plugin_catalog INSERT,
  //   (b) trigger non-clobber on caller-supplied pillar (INSERT + UPDATE),
  //   (c) `workspace_plugins` BEFORE INSERT trigger filling `pillar` +
  //       `install_id` when callers omit them,
  //   (d) the partial unique `workspace_plugins_singleton` index + the
  //       global `(workspace_id, catalog_id)` unique,
  //   (e) the prod-critical fresh-self-host backfill UPDATE chain.
  // 0096 step 7 drops all three triggers; 0096 step 6 collapses the
  // unique indexes into the composite PK `(workspace_id, catalog_id,
  // install_id)`. None of (a)–(d) describe behavior that survives 0096,
  // so replay would either trip 23514 (CHECK on now-required pillar)
  // or 23505 against the new PK. (e) was a one-shot upgrade-path
  // assertion that doesn't apply once the schema is stable. The
  // post-cutover schema shape (CHECK constraints on pillar, NOT NULL
  // on pillar+install_id, composite PK, demo per-workspace backfill,
  // `status` column) is covered structurally by the `0096: cutover`
  // describe + the full migration replay at `beforeAll`.

  // ─────────────────────────────────────────────────────────────────────
  // 0108 — openapi-generic Datasource catalog seed (#2926 / #3011 GAP 3)
  //
  // The end-to-end run above only asserts count>0; an `INSERT ... ON CONFLICT
  // DO NOTHING` that silently no-ops (a constraint collision on a future
  // schema drift) would still "pass" with this catalog row ABSENT. The NOVEL
  // coverage here is the `toHaveLength(1)` row-presence check after the full
  // migration replay — that the INSERT actually landed. The column pins below
  // (type/pillar/install_model + the `secret:true` field) overlap with
  // catalog-seed.test.ts's static `migration 0108 ↔ code alignment` assertions;
  // they ride along as cheap insurance against a partial-landing drift. Pinned
  // because the install pipeline reads them: type + pillar route the row through
  // the OpenApiDatasourceRegistry (no SQL pool), install_model drives the admin
  // form, and `secret:true` is what encryptSecretFields encrypts at rest (a
  // dropped flag plaintexts the token).
  // ─────────────────────────────────────────────────────────────────────
  it("0108: seeds the openapi-generic datasource catalog row with the credential field marked secret (#3011)", async () => {
    const { rows } = await pool.query<{
      type: string;
      pillar: string;
      install_model: string;
      config_schema: Array<{ key: string; secret?: boolean }>;
    }>(
      `SELECT type, pillar, install_model, config_schema
         FROM plugin_catalog
        WHERE id = 'catalog:openapi-generic'`,
    );
    // The INSERT actually landed a row — not a silent ON CONFLICT no-op.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("datasource");
    expect(rows[0]?.pillar).toBe("datasource");
    expect(rows[0]?.install_model).toBe("form");

    // Exactly the credential field carries secret:true, so encryptSecretFields
    // encrypts `auth_value` in workspace_plugins.config at install time.
    const secretKeys = (rows[0]?.config_schema ?? [])
      .filter((f) => f.secret === true)
      .map((f) => f.key);
    expect(secretKeys).toEqual(["auth_value"]);
  }, PG_TEST_TIMEOUT_MS);

  // ─────────────────────────────────────────────────────────────────────
  // 0125 — elasticsearch auth-modes config_schema (#3263–#3266)
  //
  // 0123 inserts the elasticsearch catalog row with only url/apiKey/description;
  // 0125 UPDATEs its `config_schema` to the full auth-mode + engine set. After
  // the replay the row must carry all four `secret:true` credential fields so the
  // schema-driven `ElasticsearchFormInstallHandler` encrypts them at rest. A
  // malformed JSONB in 0125 (which the mock-pool migrate.test.ts can't catch)
  // would surface here against real Postgres.
  // ─────────────────────────────────────────────────────────────────────
  it("0125: updates the elasticsearch catalog row to mark every auth-mode secret (#3263–#3266)", async () => {
    const { rows } = await pool.query<{
      config_schema: Array<{ key: string; type?: string; secret?: boolean }>;
    }>(
      `SELECT config_schema
         FROM plugin_catalog
        WHERE id = 'catalog:elasticsearch'`,
    );
    expect(rows).toHaveLength(1);
    const schema = rows[0]?.config_schema ?? [];
    const secretKeys = schema.filter((f) => f.secret === true).map((f) => f.key).sort();
    expect(secretKeys).toEqual(
      ["apiKey", "awsSecretAccessKey", "awsSessionToken", "password"].sort(),
    );
    // The engine select rode along with the auth-mode update.
    expect(schema.find((f) => f.key === "engine")?.type).toBe("select");
  }, PG_TEST_TIMEOUT_MS);

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
    // unobservable. The dedicated pre-0096 fixture describe block below
    // covers the post-state invariants against a hand-seeded pre-cutover
    // schema.

    // Type and pillar are orthogonal post-0096; the legacy 0092 BEFORE
    // UPDATE trigger (`plugin_catalog_sync_pillar_on_type_change`) that
    // coupled them was dropped in 0096 step 7.
    it("admin marketplace PATCH of plugin_catalog.type does not mutate pillar (#2793 gap 2)", async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const id = `cat-decouple-${stamp}`;
      const slug = `decouple-${stamp}`;

      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES ($1, 'Decouple Smoke', $2, 'chat', 'chat', 'oauth')`,
        [id, slug],
      );

      // Mirrors the admin marketplace PATCH shape — a single-column UPDATE
      // on `type` that omits `pillar`. Pre-0096 the trigger would have
      // overwritten pillar to 'datasource' to match the new type; post-0096
      // pillar must be left untouched.
      await pool.query(
        `UPDATE plugin_catalog SET type = 'datasource' WHERE id = $1`,
        [id],
      );

      const { rows } = await pool.query<{ type: string; pillar: string }>(
        `SELECT type, pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("datasource");
      expect(rows[0]?.pillar).toBe("chat");
    }, PG_TEST_TIMEOUT_MS);

    // Companion to the gap-2 orthogonality assertion. The "only-type"
    // case proves there's no trigger silently re-deriving pillar; this
    // case proves the schema CHECK still admits independent values when
    // a caller names both columns — i.e. a hypothetical future
    // generated-column or CHECK coupling type↔pillar would fail here.
    it("admin marketplace PATCH that names both type and pillar lands both values verbatim (#2793 gap 2)", async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const id = `cat-both-${stamp}`;
      const slug = `both-${stamp}`;

      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES ($1, 'Both Axes Smoke', $2, 'chat', 'chat', 'oauth')`,
        [id, slug],
      );

      await pool.query(
        `UPDATE plugin_catalog SET type = 'datasource', pillar = 'action' WHERE id = $1`,
        [id],
      );

      const { rows } = await pool.query<{ type: string; pillar: string }>(
        `SELECT type, pillar FROM plugin_catalog WHERE id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("datasource");
      expect(rows[0]?.pillar).toBe("action");
    }, PG_TEST_TIMEOUT_MS);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 0120 — static-bot routing-id partial unique index (#3167)
  //
  // Closes the concurrent-install race: two DIFFERENT workspaces binding
  // the SAME routing id (Telegram chat_id / Discord guild_id / Teams
  // tenant_id / WhatsApp phone_number_id / gchat workspace_id) can no longer
  // both persist. The losing writer hits a 23505 on
  // `workspace_plugins_chat_routing_id_unique`, which the handlers map to the
  // actionable "already connected elsewhere" error
  // (`isRoutingIdUniqueViolation` keys on that exact index name).
  //
  // Carve-outs proved here mirror the migration's intent:
  //   - gchat `my_customer` self-install alias is exempt (NULLIF → NULL,
  //     DISTINCT in the index);
  //   - the SAME routing value under two different platforms does NOT collide
  //     (the leading `catalog_id` column scopes per platform);
  //   - a disabled install frees its routing id for reuse (partial WHERE
  //     enabled = true);
  //   - a same-workspace reconnect UPSERT is idempotent (lands on its own
  //     singleton row, routing value unchanged).
  // ─────────────────────────────────────────────────────────────────────
  describe("0120 static-bot routing-id uniqueness (#3167)", () => {
    // Chat catalog rows aren't seeded by migrations (catalog-seeder runs at
    // boot, not here), so seed every static-bot platform these tests exercise.
    // ON CONFLICT DO NOTHING keeps it idempotent across this schema.
    beforeAll(async () => {
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES
           ('catalog:telegram', 'Telegram',    'telegram', 'chat', 'chat', 'static-bot'),
           ('catalog:discord',  'Discord',     'discord',  'chat', 'chat', 'static-bot'),
           ('catalog:teams',    'Microsoft Teams', 'teams', 'chat', 'chat', 'static-bot'),
           ('catalog:whatsapp', 'WhatsApp',    'whatsapp', 'chat', 'chat', 'static-bot'),
           ('catalog:gchat',    'Google Chat', 'gchat',    'chat', 'chat', 'static-bot')
         ON CONFLICT (id) DO NOTHING`,
      );
    });

    // One entry per static-bot CASE arm in the migration. Driving the
    // rejection test off this list proves all five arms end-to-end against
    // real Postgres — a wrong JSONB key in any arm (the CASE is the single
    // source of the per-platform routing-key contract) would fail here. The
    // `sample` values are deliberately NOT `my_customer` so gchat exercises
    // the constrained (non-NULLIF) path; the alias carve-out is a separate test.
    const PLATFORM_ROUTING_KEYS: ReadonlyArray<{
      platform: string;
      catalogId: string;
      key: string;
      sample: (stamp: string) => string;
    }> = [
      { platform: "Telegram", catalogId: "catalog:telegram", key: "chat_id", sample: (s) => `-1001${s.slice(0, 9)}` },
      { platform: "Discord", catalogId: "catalog:discord", key: "guild_id", sample: (s) => `12${s.slice(0, 16)}` },
      { platform: "Teams", catalogId: "catalog:teams", key: "tenant_id", sample: (s) => `tenant-${s}` },
      { platform: "WhatsApp", catalogId: "catalog:whatsapp", key: "phone_number_id", sample: (s) => `10${s.slice(0, 12)}` },
      { platform: "gchat", catalogId: "catalog:gchat", key: "workspace_id", sample: (s) => `C0${s.slice(0, 7)}` },
    ];

    /** Insert one chat install row. Throws on a routing-id unique violation. */
    async function installChat(opts: {
      id: string;
      workspaceId: string;
      catalogId: string;
      config: Record<string, string>;
      enabled?: boolean;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, $5, NOW())`,
        [
          opts.id,
          opts.workspaceId,
          opts.catalogId,
          JSON.stringify(opts.config),
          opts.enabled ?? true,
        ],
      );
    }

    // One rejection test per platform — exercises every CASE arm end-to-end.
    // (A loop, not it.each, so the assertion runs against real Postgres for
    // each arm with the platform name in the test title.)
    for (const p of PLATFORM_ROUTING_KEYS) {
      it(`rejects a second workspace binding the same ${p.platform} ${p.key} with 23505 on the routing index (#3167)`, async () => {
        const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
        const routingId = p.sample(stamp);
        await installChat({
          id: `wp-a-${p.platform}-${stamp}`,
          workspaceId: `wsA-${p.platform}-${stamp}`,
          catalogId: p.catalogId,
          config: { [p.key]: routingId },
        });

        let err: { code?: string; constraint?: string } | null = null;
        try {
          await installChat({
            id: `wp-b-${p.platform}-${stamp}`,
            workspaceId: `wsB-${p.platform}-${stamp}`,
            catalogId: p.catalogId,
            config: { [p.key]: routingId },
          });
        } catch (e) {
          err = e as { code?: string; constraint?: string };
        }
        expect(err?.code).toBe("23505");
        // The handlers' `isRoutingIdUniqueViolation` keys on this exact name —
        // a rename here without updating the helper would silently regress the
        // error mapping back to a raw 500.
        expect(err?.constraint).toBe("workspace_plugins_chat_routing_id_unique");
      }, PG_TEST_TIMEOUT_MS);
    }

    it("allows a same-workspace reconnect UPSERT of its own chat_id — idempotent, no conflict (#3167)", async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const ws = `wsRecon-${stamp}`;
      const chatId = `-100555${stamp.replace(/\D/g, "").slice(0, 6)}`;
      await installChat({
        id: `wp-r1-${stamp}`,
        workspaceId: ws,
        catalogId: "catalog:telegram",
        config: { chat_id: chatId },
      });
      // Mirror the handler UPSERT exactly: ON CONFLICT on the singleton index
      // lands on the existing row; the routing value is unchanged, so the
      // routing index sees no NEW conflicting entry against another row.
      await pool.query(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, 'catalog:telegram', $1, 'chat', $3::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE SET config = EXCLUDED.config, enabled = true`,
        [`wp-r2-${stamp}`, ws, JSON.stringify({ chat_id: chatId, display_name: "renamed" })],
      );
      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM workspace_plugins
          WHERE workspace_id = $1 AND catalog_id = 'catalog:telegram'`,
        [ws],
      );
      expect(rows[0]?.c).toBe(1);
    }, PG_TEST_TIMEOUT_MS);

    it("exempts the gchat 'my_customer' self-install alias — two workspaces store it without conflict (#3167)", async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await installChat({
        id: `wp-mc-a-${stamp}`,
        workspaceId: `wsMcA-${stamp}`,
        catalogId: "catalog:gchat",
        config: { workspace_id: "my_customer" },
      });
      // NULLIF(config->>'workspace_id', 'my_customer') => NULL, which is
      // DISTINCT in the index, so a second self-install must NOT conflict.
      await installChat({
        id: `wp-mc-b-${stamp}`,
        workspaceId: `wsMcB-${stamp}`,
        catalogId: "catalog:gchat",
        config: { workspace_id: "my_customer" },
      });
      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM workspace_plugins
          WHERE catalog_id = 'catalog:gchat'
            AND config->>'workspace_id' = 'my_customer'
            AND id LIKE $1`,
        [`wp-mc-%-${stamp}`],
      );
      expect(rows[0]?.c).toBe(2);
    }, PG_TEST_TIMEOUT_MS);

    // (The gchat arm of the rejection loop above already proves a REAL
    // customer id — i.e. not `my_customer` — is constrained, the positive
    // counterpart to the `my_customer` exemption test below.)

    it("does NOT collide the same routing value across two different platforms (#3167)", async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const shared = `1234567${stamp.replace(/\D/g, "").slice(0, 8)}`;
      await installChat({
        id: `wp-tg-${stamp}`,
        workspaceId: `wsTg-${stamp}`,
        catalogId: "catalog:telegram",
        config: { chat_id: shared },
      });
      // Discord guild_id with the identical string — different catalog_id, so
      // (catalog_id, value) differs and there is no conflict. The leading
      // catalog_id column is what keeps routing values namespaced per platform.
      await installChat({
        id: `wp-dc-${stamp}`,
        workspaceId: `wsDc-${stamp}`,
        catalogId: "catalog:discord",
        config: { guild_id: shared },
      });
      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM workspace_plugins WHERE id IN ($1, $2)`,
        [`wp-tg-${stamp}`, `wp-dc-${stamp}`],
      );
      expect(rows[0]?.c).toBe(2);
    }, PG_TEST_TIMEOUT_MS);

    it("a disabled install frees its routing id — another workspace may then claim it (#3167)", async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const chatId = `-100777${stamp.replace(/\D/g, "").slice(0, 6)}`;
      // Disabled row sits OUTSIDE the partial index (WHERE enabled = true).
      await installChat({
        id: `wp-dis-${stamp}`,
        workspaceId: `wsDis-${stamp}`,
        catalogId: "catalog:telegram",
        config: { chat_id: chatId },
        enabled: false,
      });
      // Enabled install in a different workspace with the same chat_id — no
      // conflict, because the disabled row isn't in the index.
      await installChat({
        id: `wp-en-${stamp}`,
        workspaceId: `wsEn-${stamp}`,
        catalogId: "catalog:telegram",
        config: { chat_id: chatId },
        enabled: true,
      });
      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM workspace_plugins
          WHERE catalog_id = 'catalog:telegram' AND config->>'chat_id' = $1`,
        [chatId],
      );
      expect(rows[0]?.c).toBe(2);
    }, PG_TEST_TIMEOUT_MS);

    it("scopes the index to pillar = 'chat' — an action-pillar row with a routing-key-shaped config does NOT collide (#3167)", async () => {
      // Isolates the `pillar = 'chat'` half of the partial predicate (the
      // disabled test above covers the `enabled = true` half). A row on the
      // SAME catalog whose CASE arm matches (so it's only the pillar clause
      // keeping it out of the index) must not conflict with an enabled chat
      // row sharing the routing value. The denormalized `pillar = 'action'`
      // on a telegram catalog row can't arise from the real install path, but
      // it's the minimal way to exercise the pillar clause in isolation — if
      // the migration dropped `pillar = 'chat'`, this would 23505.
      const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const chatId = `-100888${stamp.slice(0, 6)}`;
      await installChat({
        id: `wp-chat-${stamp}`,
        workspaceId: `wsChat-${stamp}`,
        catalogId: "catalog:telegram",
        config: { chat_id: chatId },
      });
      // Raw insert with pillar = 'action' (installChat hardcodes 'chat').
      await pool.query(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, 'catalog:telegram', $1, 'action', $3::jsonb, true, NOW())`,
        [`wp-action-${stamp}`, `wsAction-${stamp}`, JSON.stringify({ chat_id: chatId })],
      );
      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM workspace_plugins
          WHERE catalog_id = 'catalog:telegram' AND config->>'chat_id' = $1`,
        [chatId],
      );
      expect(rows[0]?.c).toBe(2);
    }, PG_TEST_TIMEOUT_MS);

    it("exempts a chat install whose routing key is absent — CASE yields NULL, which is DISTINCT (#3167)", async () => {
      // Same NULL-distinctness mechanism the `my_customer` carve-out relies on:
      // a telegram row with no `chat_id` produces a NULL index key, so two such
      // rows never conflict. Documents this as intentional (not an accident).
      const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      await installChat({
        id: `wp-nokey-a-${stamp}`,
        workspaceId: `wsNoKeyA-${stamp}`,
        catalogId: "catalog:telegram",
        config: { display_name: "no-routing-key-a" },
      });
      await installChat({
        id: `wp-nokey-b-${stamp}`,
        workspaceId: `wsNoKeyB-${stamp}`,
        catalogId: "catalog:telegram",
        config: { display_name: "no-routing-key-b" },
      });
      const { rows } = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM workspace_plugins WHERE id LIKE $1`,
        [`wp-nokey-%-${stamp}`],
      );
      expect(rows[0]?.c).toBe(2);
    }, PG_TEST_TIMEOUT_MS);

    it("creates the partial unique index with the expected predicate + CASE definition — drift guard (#3167)", async () => {
      const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'workspace_plugins'
          ORDER BY indexname`,
      );
      const idx = rows.find((r) => r.indexname === "workspace_plugins_chat_routing_id_unique");
      expect(idx).toBeDefined();
      const def = idx?.indexdef ?? "";
      // Pin the load-bearing pieces so a migration edit that drops the partial
      // predicate, the NULLIF carve-out, or a platform's routing key fails here
      // even when no behavioral test happens to exercise that exact arm.
      expect(def).toMatch(/UNIQUE INDEX/i);
      expect(def).toMatch(/WHERE .*enabled.*AND.*pillar = 'chat'/is);
      expect(def).toMatch(/NULLIF/i);
      for (const key of ["chat_id", "guild_id", "tenant_id", "phone_number_id", "workspace_id"]) {
        expect(def).toContain(key);
      }
    }, PG_TEST_TIMEOUT_MS);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Form-install singleton upsert — schema-side pin.
  //
  // The form-install spine's upsert is executed VERBATIM against the
  // live schema in `integrations/install/__tests__/
  // persist-form-install-pg.test.ts` (module-colocated per the
  // chat-cap-pg precedent). What stays HERE is the pure schema
  // property that consolidation was forced by: the pre-spine legacy
  // INSERT shape must keep being rejected at plan time.
  // ─────────────────────────────────────────────────────────────────────
  describe("form-install singleton upsert: legacy-shape rejection (schema property)", () => {
    beforeAll(async () => {
      // Action catalog rows aren't seeded by migrations (catalog-seeder
      // runs at boot) — seed one for the FK target.
      await pool.query(
        `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
         VALUES ('catalog:spine-email', 'Email', 'spine-email', 'integration', 'action', 'form')
         ON CONFLICT (id) DO NOTHING`,
      );
    });

    it("the pre-spine legacy shape is rejected by the live schema (42P10 — regression documentation)", async () => {
      // The exact SQL the Email/Webhook/Obsidian handlers carried before
      // the spine. If this ever starts SUCCEEDING, a non-partial unique
      // on (workspace_id, catalog_id) has been reintroduced — datasource
      // multi-instance installs would break; investigate before relying
      // on it.
      let err: { code?: string } | null = null;
      try {
        await pool.query(
          `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
           VALUES ($1, $2, $3, $4::jsonb, true, NOW())
           ON CONFLICT (workspace_id, catalog_id) DO UPDATE
             SET config = EXCLUDED.config,
                 enabled = true
           RETURNING id`,
          [`spine-legacy-${Date.now()}`, `ws-spine-legacy`, "catalog:spine-email", "{}"],
        );
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err?.code).toBe("42P10");
    }, PG_TEST_TIMEOUT_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────
// #2793 gap 1 — pre-0096 snapshot fixture for the backfill replay.
//
// The main describeIfPg above runs the full migration set (including
// 0096) once, then asserts post-state. By that point the `connections`
// table is gone, so any 1.5.4 schema change that alters `workspace_plugins`
// columns or `plugin_catalog` shape in a way that breaks the
// connections-to-workspace_plugins backfill (0096 step 2) would pass the
// main smoke silently. This block isolates the BACKFILL semantics:
//   1. runs every migration UP TO 0095 against a fresh per-test schema
//      (so `connections` / `connection_groups` / pre-0096 workspace_plugins
//      all exist),
//   2. seeds representative pre-0096 rows whose post-state is well-known,
//   3. executes 0096 + 0097 verbatim from the migration files,
//   4. asserts the post-state — URL ciphertext is copied byte-for-byte,
//      `status` and derived `enabled` survive, the two legacy tables are
//      dropped, and 0097's no-op skip path fires cleanly.
//
// A 1.5.4 migration that drops `workspace_plugins.config`, renames
// `workspace_plugins.install_id`, or changes `plugin_catalog.slug`
// shape will fail this test instead of landing a broken backfill on a
// fresh self-host install.
// ─────────────────────────────────────────────────────────────────────

describeIfPg("migrate-pg: pre-0096 snapshot fixture (#2793 gap 1)", () => {
  let pool: Pool;
  const schemaName = `pre_0096_smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const migrationsDir = join(import.meta.dir, "..", "migrations");

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `migrate-pg pre-0096: SET search_path failed on new connection: ${message}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it("replays 0096 backfill against a pre-0096 schema and lands the documented post-state", async () => {
    // 1. Apply every migration up to 0095. Computing `post0096` from the
    // on-disk migration set keeps this stable as 1.5.4 migrations land —
    // anything lexically >= "0096_" gets skipped here and applied below.
    const allFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const post0096 = allFiles.filter((f) => f.localeCompare("0096_") >= 0);
    // Sanity — if the partition is empty, the test is testing nothing.
    expect(post0096).toContain("0096_drop_connections_table.sql");
    expect(post0096).toContain("0097_fix_0096_us_constraint_order.sql");

    const applied = await runMigrations(pool, {
      skip: [...MANAGED_AUTH_MIGRATIONS, ...post0096],
    });
    expect(applied).toBeGreaterThan(0);

    // 2. Seed pre-0096 fixture data. Three cases worth pinning:
    //   - a `published` postgres connection with non-trivial config
    //     (description, schema_name, group_id) — exercises the full
    //     jsonb_build_object payload in 0096 step 2.
    //   - an `archived` mysql connection — exercises the `enabled =
    //     (status != 'archived')` derivation and the `status` carry-through.
    //   - URL ciphertext in the `enc:v1:iv:tag:ct` shape that
    //     `decryptSecretFields` recognises — verifies 0096 copies the
    //     ciphertext byte-for-byte rather than re-encrypting (which
    //     would land a different IV on the post-state row).
    //
    // `connections.group_id` is NOT NULL post-0069 with a composite FK
    // to `connection_groups (id, org_id)`. Seed two distinct groups so
    // the test exercises the `config->>'group_id'` carry-through that
    // the no-FK `connection_group_id` columns rely on post-cutover.
    const orgId = `ws-pre0096-${Date.now()}`;
    const ciphertextPg = "enc:v1:aaaa-iv:bbbb-tag:cccc-postgres-payload";
    const ciphertextMy = "enc:v1:dddd-iv:eeee-tag:ffff-mysql-payload";

    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name) VALUES
         ('grp-prod',     $1, 'Prod'),
         ('grp-reporting', $1, 'Reporting')`,
      [orgId],
    );

    await pool.query(
      `INSERT INTO connections (id, url, type, description, schema_name, org_id, status, group_id)
       VALUES
         ('conn-pg', $1, 'postgres', 'production read replica', 'public', $2, 'published', 'grp-prod'),
         ('conn-my', $3, 'mysql',    'reporting copy',          NULL,     $2, 'archived',  'grp-reporting')`,
      [ciphertextPg, orgId, ciphertextMy],
    );

    // Pre-cutover sanity: the legacy global unique constraint that 0096
    // step 6 drops must exist on the pre-0096 schema. If 1.5.4 ever
    // re-introduces a column rename that loses this index, the test
    // catches it here rather than in production at cutover time.
    const { rows: preLegacy } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'workspace_plugins'
          AND indexname IN ('workspace_plugins_workspace_id_catalog_id_key', 'idx_workspace_plugins_unique')`,
    );
    expect(preLegacy.length).toBeGreaterThan(0);

    // 3. Read 0096 + 0097 SQL verbatim and execute them. Loading via
    // `readFileSync` (not a hand-rolled copy) means any drift in the
    // migration files surfaces here as actual production-equivalent
    // behavior.
    const sql0096 = readFileSync(
      join(migrationsDir, "0096_drop_connections_table.sql"),
      "utf-8",
    );
    await pool.query(sql0096);

    // 4. Assert post-state — the four invariants the cutover guarantees.

    // (a) Legacy tables are gone.
    const { rows: legacy } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('connections', 'connection_groups')`,
    );
    expect(legacy).toHaveLength(0);

    // (b) The postgres row backfilled with verbatim URL ciphertext +
    // the full jsonb_build_object payload (schema, description, db_type,
    // group_id). status='published' carries through; enabled=true.
    const { rows: pgRows } = await pool.query<{
      install_id: string;
      pillar: string;
      status: string;
      enabled: boolean;
      config: {
        url: string;
        schema?: string;
        description?: string;
        db_type?: string;
        group_id?: string;
      };
    }>(
      `SELECT install_id, pillar, status, enabled, config
         FROM workspace_plugins
        WHERE workspace_id = $1 AND install_id = 'conn-pg'`,
      [orgId],
    );
    expect(pgRows).toHaveLength(1);
    expect(pgRows[0]!.pillar).toBe("datasource");
    expect(pgRows[0]!.status).toBe("published");
    expect(pgRows[0]!.enabled).toBe(true);
    // Bit-exact ciphertext copy is the load-bearing assertion — a future
    // refactor that re-encrypts (different IV, different ciphertext) would
    // break this and silently invalidate every existing connection.
    expect(pgRows[0]!.config.url).toBe(ciphertextPg);
    expect(pgRows[0]!.config.db_type).toBe("postgres");
    expect(pgRows[0]!.config.schema).toBe("public");
    expect(pgRows[0]!.config.description).toBe("production read replica");
    expect(pgRows[0]!.config.group_id).toBe("grp-prod");

    // (c) The archived mysql row backfilled with status='archived',
    // enabled=false (derived), and the NULL `schema_name` stripped by
    // jsonb_strip_nulls — `group_id` survives because it's NOT NULL
    // post-0069 and is the field that keeps the no-FK
    // `connection_group_id` columns matching post-cutover.
    const { rows: myRows } = await pool.query<{
      status: string;
      enabled: boolean;
      config: { url: string; schema?: string; group_id?: string };
    }>(
      `SELECT status, enabled, config
         FROM workspace_plugins
        WHERE workspace_id = $1 AND install_id = 'conn-my'`,
      [orgId],
    );
    expect(myRows).toHaveLength(1);
    expect(myRows[0]!.status).toBe("archived");
    expect(myRows[0]!.enabled).toBe(false);
    expect(myRows[0]!.config.url).toBe(ciphertextMy);
    expect(myRows[0]!.config.group_id).toBe("grp-reporting");
    // jsonb_strip_nulls dropped the NULL schema_name field.
    expect(myRows[0]!.config.schema).toBeUndefined();

    // (d) The legacy global unique is gone post-cutover. Datasource
    // installs are legitimately multi-instance per (workspace, catalog)
    // from here on; the pillar-aware partial unique on chat/action
    // (`workspace_plugins_singleton`) is the sole singleton gate.
    const { rows: postLegacy } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'workspace_plugins'
          AND indexname IN ('workspace_plugins_workspace_id_catalog_id_key', 'idx_workspace_plugins_unique')`,
    );
    expect(postLegacy).toHaveLength(0);
    const { rows: singleton } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'workspace_plugins'
          AND indexname = 'workspace_plugins_singleton'`,
    );
    expect(singleton).toHaveLength(1);

    // 5. 0097 against a post-0096 state is a documented no-op (RAISE
    // NOTICE skip path because `connections` is gone). Running it must
    // not throw and must not duplicate the backfilled rows.
    const sql0097 = readFileSync(
      join(migrationsDir, "0097_fix_0096_us_constraint_order.sql"),
      "utf-8",
    );
    await pool.query(sql0097);

    const { rows: afterCounts } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM workspace_plugins WHERE workspace_id = $1`,
      [orgId],
    );
    expect(afterCounts[0]?.count).toBe(2);
  }, PG_TEST_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────
// #2793 gap 1 follow-up — 0096 step 3 per-workspace demo backfill.
//
// Step 3 of 0096 is the largest in-migration code path (~140 lines of
// `DO $$` with four `RAISE EXCEPTION` guards: demo_url_count,
// conflicting_demo_count, missing_demo_count, excess_demo_count) and the
// other fixture block above can't exercise it because it intentionally
// has no `organization` table (so step 3 self-defers). This block stubs
// the minimum `organization` shape, seeds the `__global__`/`__demo__`
// connection row plus two orgs, then replays 0096 and asserts every org
// owns exactly one `demo-postgres` install with `install_id='__demo__'`.
// A future refactor that breaks the `WHERE NOT EXISTS` + `ON CONFLICT`
// combo (silently dropping rows) fails here instead of landing in prod.
// ─────────────────────────────────────────────────────────────────────

describeIfPg("migrate-pg: 0096 step 3 demo backfill fixture (#2793 gap 1 follow-up)", () => {
  let pool: Pool;
  const schemaName = `pre_0096_demo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const migrationsDir = join(import.meta.dir, "..", "migrations");

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `migrate-pg pre-0096 demo: SET search_path failed on new connection: ${message}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it("step 3 backfills exactly one demo-postgres install per organization with install_id='__demo__'", async () => {
    const allFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const post0096 = allFiles.filter((f) => f.localeCompare("0096_") >= 0);

    await runMigrations(pool, {
      skip: [...MANAGED_AUTH_MIGRATIONS, ...post0096],
    });

    // Minimal `organization` stub. 0096 step 3's `SELECT 1 FROM
    // information_schema.tables WHERE table_name = 'organization'` guard
    // only checks for table presence; the body reads `o.id` and nothing
    // else. A single-column stub keeps the fixture decoupled from Better
    // Auth's full organization schema (which lives outside the migration
    // set under MANAGED_AUTH_MIGRATIONS).
    await pool.query(`CREATE TABLE organization (id TEXT PRIMARY KEY)`);
    await pool.query(
      `INSERT INTO organization (id) VALUES ('ws-demo-alpha'), ('ws-demo-beta')`,
    );

    // The `__demo__`/`__global__` connection row is the source the step 3
    // SELECT copies `url` from. Without it, the migration's `demo_url_count`
    // branch logs a NOTICE and skips — which is a different code path.
    // group_id is NOT NULL post-0069; seed a matching group row.
    const demoUrl = "enc:v1:demo-iv:demo-tag:demo-ciphertext";
    await pool.query(
      `INSERT INTO connection_groups (id, org_id, name)
       VALUES ('grp-global-demo', '__global__', 'Global Demo')`,
    );
    await pool.query(
      `INSERT INTO connections (id, url, type, description, org_id, status, group_id)
       VALUES ('__demo__', $1, 'postgres', 'shared demo', '__global__', 'published', 'grp-global-demo')`,
      [demoUrl],
    );

    // Replay 0096 verbatim. Step 2 skips the (`__global__`, `__demo__`)
    // row explicitly; step 3 should INSERT one row per organization.
    const sql0096 = readFileSync(
      join(migrationsDir, "0096_drop_connections_table.sql"),
      "utf-8",
    );
    await pool.query(sql0096);

    // Each org owns exactly one demo-postgres install, all with
    // `install_id='__demo__'`, all sharing the operator-shared URL
    // ciphertext bit-for-bit.
    const { rows } = await pool.query<{
      workspace_id: string;
      install_id: string;
      pillar: string;
      enabled: boolean;
      status: string;
      config: { url: string; description?: string; db_type?: string };
    }>(
      `SELECT wp.workspace_id, wp.install_id, wp.pillar, wp.enabled, wp.status, wp.config
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE pc.slug = 'demo-postgres'
        ORDER BY wp.workspace_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.workspace_id)).toEqual(["ws-demo-alpha", "ws-demo-beta"]);
    for (const row of rows) {
      expect(row.install_id).toBe("__demo__");
      expect(row.pillar).toBe("datasource");
      expect(row.enabled).toBe(true);
      expect(row.status).toBe("published");
      expect(row.config.url).toBe(demoUrl);
      expect(row.config.db_type).toBe("postgres");
      expect(row.config.description).toBe("Atlas-managed demo Postgres dataset");
    }
  }, PG_TEST_TIMEOUT_MS);
});

// #2377 — organization dormancy gate. Migration 0115 (`ALTER TABLE
// organization ADD COLUMN last_active_at`) is Better-Auth-managed, so the
// main run above skips it — this block applies it explicitly against a stub
// `organization` table to validate the ALTER on real Postgres, then asserts
// the dormancy-gate SELECT (the exact production SQL from
// `buildStaleCatalogQuery`) actually selects active + orphaned-config orgs
// and skips the dormant one. The scheduler unit tests mock `internalQuery`,
// so this is the only place the `IS NULL OR last_active_at > threshold`
// predicate runs against live rows — it guards the diff's most safety-
// critical claim (the gate never drops a refresh the legacy query would do).
// ─────────────────────────────────────────────────────────────────────

describeIfPg("migrate-pg: 0115 organization dormancy gate (#2377)", () => {
  let pool: Pool;
  const schemaName = `dormancy_2377_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const migrationsDir = join(import.meta.dir, "..", "migrations");
  const ONE_DAY_MS = 86_400_000;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`migrate-pg 0115 dormancy: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it("applies 0115 then selects active + orphan, skips dormant", async () => {
    // Run the normal set so workspace_model_config / workspace_model_catalog
    // exist. organization is skipped (Better-Auth-managed), so we stub it.
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Minimal pre-0115 `organization` shape (no last_active_at yet).
    await pool.query(`CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT)`);
    await pool.query(
      `INSERT INTO organization (id, name) VALUES ('org-active', 'A'), ('org-dormant', 'D')`,
    );

    // Apply the REAL migration 0115 verbatim — this exercises the ALTER
    // (guard + NOT NULL DEFAULT now() + backfill) against live Postgres.
    const sql0115 = readFileSync(
      join(migrationsDir, "0115_org_last_active_at.sql"),
      "utf-8",
    );
    await pool.query(sql0115);

    // Column landed NOT NULL and existing rows backfilled.
    const col = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'organization'
          AND column_name = 'last_active_at'`,
    );
    expect(col.rows[0]?.is_nullable).toBe("NO");
    expect(col.rows[0]?.data_type).toBe("timestamp with time zone");
    const backfilled = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM organization WHERE last_active_at IS NULL`,
    );
    expect(backfilled.rows[0]?.n).toBe("0");

    // active = now (within window); dormant = 60 days ago (outside 30d window).
    await pool.query(`UPDATE organization SET last_active_at = now() WHERE id = 'org-active'`);
    await pool.query(
      `UPDATE organization SET last_active_at = now() - interval '60 days' WHERE id = 'org-dormant'`,
    );

    // Configs for active, dormant, and an ORPHAN (no organization row).
    await pool.query(
      `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted) VALUES
         ('org-active', 'anthropic', 'm', 'enc'),
         ('org-dormant', 'anthropic', 'm', 'enc'),
         ('org-orphan', 'anthropic', 'm', 'enc')`,
    );
    // All catalogs stale (2 days old) vs the 1-day TTL below.
    await pool.query(
      `INSERT INTO workspace_model_catalog (org_id, provider, region, payload, fetched_at) VALUES
         ('org-active', 'anthropic', '', '[]'::jsonb, now() - interval '2 days'),
         ('org-dormant', 'anthropic', '', '[]'::jsonb, now() - interval '2 days'),
         ('org-orphan', 'anthropic', '', '[]'::jsonb, now() - interval '2 days')`,
    );

    // Gated (managed) query: stale=1d, limit=100, dormancy=30d.
    const gated = await pool.query<{ org_id: string }>(buildStaleCatalogQuery(true), [
      ONE_DAY_MS,
      100,
      30 * ONE_DAY_MS,
    ]);
    // active (recent) + orphan (NULL via LEFT JOIN miss → treated active);
    // dormant (60d) is filtered out.
    expect(gated.rows.map((r) => r.org_id).sort()).toEqual(["org-active", "org-orphan"]);

    // Legacy (TTL-only) query: no dormancy filter → all three stale rows.
    const legacy = await pool.query<{ org_id: string }>(buildStaleCatalogQuery(false), [
      ONE_DAY_MS,
      100,
    ]);
    expect(legacy.rows.map((r) => r.org_id).sort()).toEqual([
      "org-active",
      "org-dormant",
      "org-orphan",
    ]);

    // 0115 is idempotent — re-applying the ALTER IF NOT EXISTS is a no-op.
    await expect(pool.query(sql0115)).resolves.toBeDefined();
  }, PG_TEST_TIMEOUT_MS);

  // 0143 (#3745, ADR-0020) — agent_runs durable-session checkpoint store.
  // The status CHECK constraint and the conversation FK cascade are the two
  // teeth of the schema: a bad status must reject (23514) and a deleted
  // conversation must take its runs with it.
  it("0143: agent_runs status CHECK rejects unknown values with 23514", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    const conversationId = rows[0]!.id;

    // A canonical terminal status writes cleanly.
    await pool.query(
      `INSERT INTO agent_runs (conversation_id, status, transcript)
       VALUES ($1, 'done', '[]'::jsonb)`,
      [conversationId],
    );

    // An out-of-enum status rejects at the DB layer.
    await expect(
      pool.query(
        `INSERT INTO agent_runs (conversation_id, status, transcript)
         VALUES ($1, 'finished', '[]'::jsonb)`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }, PG_TEST_TIMEOUT_MS);

  it("0143: status defaults to 'running' and deleting the conversation cascades", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    const conversationId = rows[0]!.id;

    // step_index defaults to 0, status defaults to 'running'.
    await pool.query(
      `INSERT INTO agent_runs (conversation_id, transcript) VALUES ($1, '[]'::jsonb)`,
      [conversationId],
    );
    const before = await pool.query<{ status: string; step_index: number }>(
      `SELECT status, step_index FROM agent_runs WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(before.rows[0]?.status).toBe("running");
    expect(before.rows[0]?.step_index).toBe(0);

    // ON DELETE CASCADE — removing the conversation removes its runs.
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
    const after = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM agent_runs WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(after.rows[0]?.c).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // 0143 (#3746, ADR-0020) — phase 1b per-step upsert SEMANTICS, executed
  // against real Postgres rather than substring-matched on a mocked SQL string.
  // These are the slice's core safety properties: ON CONFLICT (id) collapses a
  // turn to one row, GREATEST + the transcript CASE guard make a reordered
  // fire-and-forget write non-regressing, and the WHERE status guard prevents a
  // stale checkpoint from resurrecting a terminated row. A `LEAST`-for-`GREATEST`
  // typo or a missing guard passes the unit substring tests but fails here.
  it("0143 (1b): running upserts collapse to one row; step_index + transcript reorder-safe", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    const conversationId = rows[0]!.id;
    const runId = "11111111-1111-1111-1111-111111111111";

    // Three in-order per-step `running` checkpoints (steps 1 → 3).
    for (const step of [1, 2, 3]) {
      await pool.query(RUNNING_UPSERT_SQL, [
        runId,
        conversationId,
        "org-1",
        "running",
        step,
        JSON.stringify([{ role: "assistant", content: `step ${step}` }]),
      ]);
    }

    // A reordered, stale step-1 checkpoint lands LAST. GREATEST must keep the
    // step index at 3, and the transcript CASE guard must keep the step-3
    // transcript — the stale write must not pair the higher index with an
    // older, shorter transcript.
    await pool.query(RUNNING_UPSERT_SQL, [
      runId,
      conversationId,
      "org-1",
      "running",
      1,
      JSON.stringify([{ role: "assistant", content: "stale" }]),
    ]);

    const afterRunning = await pool.query<{ step_index: number; transcript: unknown }>(
      `SELECT step_index, transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    // ON CONFLICT (id) → exactly one row for the turn.
    expect(afterRunning.rowCount).toBe(1);
    expect(afterRunning.rows[0]!.step_index).toBe(3); // GREATEST held it at 3
    expect(afterRunning.rows[0]!.transcript).toEqual([{ role: "assistant", content: "step 3" }]);

    // Terminal write flips the SAME row to done with the authoritative
    // transcript — still one row, terminal transcript wins unconditionally.
    await pool.query(TERMINAL_UPSERT_SQL, [
      runId,
      conversationId,
      "org-1",
      "done",
      3,
      JSON.stringify([{ role: "assistant", content: "final" }]),
    ]);
    const afterTerminal = await pool.query<{ status: string; transcript: unknown }>(
      `SELECT status, transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(afterTerminal.rowCount).toBe(1);
    expect(afterTerminal.rows[0]!.status).toBe("done");
    expect(afterTerminal.rows[0]!.transcript).toEqual([{ role: "assistant", content: "final" }]);
  }, PG_TEST_TIMEOUT_MS);

  it("0143 (1b): a stale running checkpoint can't resurrect a terminated row", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    const conversationId = rows[0]!.id;
    const runId = "22222222-2222-2222-2222-222222222222";

    // running at step 2, then a terminal `done` write at step 2.
    await pool.query(RUNNING_UPSERT_SQL, [
      runId, conversationId, "org-1", "running", 2,
      JSON.stringify([{ role: "assistant", content: "mid" }]),
    ]);
    await pool.query(TERMINAL_UPSERT_SQL, [
      runId, conversationId, "org-1", "done", 2,
      JSON.stringify([{ role: "assistant", content: "final" }]),
    ]);

    // A late, higher-step `running` checkpoint arrives AFTER the terminal write.
    // The WHERE status guard must reject the update entirely: the row stays
    // `done`, the step index stays 2, and the terminal transcript is preserved.
    await pool.query(RUNNING_UPSERT_SQL, [
      runId, conversationId, "org-1", "running", 3,
      JSON.stringify([{ role: "assistant", content: "late" }]),
    ]);

    const row = await pool.query<{ status: string; step_index: number; transcript: unknown }>(
      `SELECT status, step_index, transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(row.rows[0]!.status).toBe("done");
    expect(row.rows[0]!.step_index).toBe(2);
    expect(row.rows[0]!.transcript).toEqual([{ role: "assistant", content: "final" }]);
  }, PG_TEST_TIMEOUT_MS);

  // 0144 (#3747, ADR-0020 phase 2) — the resume lease single-flight, executed
  // against real Postgres. The atomic claim's whole job is to let exactly ONE of
  // two concurrent resumes win the run; this exercises the actual CTE/UPDATE SQL
  // the helper runs (RESUME_CLAIM_SQL), not a mock.
  it("0144: the resume claim leases a free run and rejects a second concurrent claim", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    const conversationId = rows[0]!.id;

    // A mid-flight `running` run, lease free.
    await pool.query(RUNNING_UPSERT_SQL, [
      "33333333-3333-3333-3333-333333333333",
      conversationId, "org-1", "running", 2,
      JSON.stringify([{ role: "assistant", content: "mid" }]),
    ]);

    // First claim wins: it returns the row (the transcript to resume) and stamps
    // a future lease + owner token.
    const first = await pool.query<{ id: string; step_index: number; transcript: unknown }>(
      RESUME_CLAIM_SQL,
      [conversationId, "300", "owner-A"],
    );
    expect(first.rowCount).toBe(1);
    expect(first.rows[0]!.step_index).toBe(2);
    expect(first.rows[0]!.transcript).toEqual([{ role: "assistant", content: "mid" }]);

    // Second claim while the first lease is live: the lease-free predicate no
    // longer matches, so it updates NOTHING — the single-flight rejection.
    const second = await pool.query(RESUME_CLAIM_SQL, [conversationId, "300", "owner-B"]);
    expect(second.rowCount).toBe(0);

    // The lease + owner reflect the FIRST claimer; the second never overwrote them.
    const leased = await pool.query<{ resuming_lease_owner: string; resuming_lease: string | null }>(
      `SELECT resuming_lease_owner, resuming_lease FROM agent_runs WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(leased.rows[0]!.resuming_lease_owner).toBe("owner-A");
    expect(leased.rows[0]!.resuming_lease).not.toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  it("0144: an expired lease is reclaimable (the TTL self-heal)", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    const conversationId = rows[0]!.id;
    const runId = "44444444-4444-4444-4444-444444444444";

    await pool.query(RUNNING_UPSERT_SQL, [
      runId, conversationId, "org-1", "running", 1,
      JSON.stringify([{ role: "assistant", content: "mid" }]),
    ]);
    // Stamp an ALREADY-EXPIRED lease held by a resumer that died mid-resume.
    await pool.query(
      `UPDATE agent_runs SET resuming_lease = now() - interval '1 minute', resuming_lease_owner = 'dead-resumer' WHERE id = $1`,
      [runId],
    );

    // A fresh claim must reclaim it (the expired-lease predicate matches) and
    // take over the owner token — the run self-heals rather than wedging forever.
    const reclaim = await pool.query(RESUME_CLAIM_SQL, [conversationId, "300", "owner-C"]);
    expect(reclaim.rowCount).toBe(1);
    const after = await pool.query<{ resuming_lease_owner: string }>(
      `SELECT resuming_lease_owner FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(after.rows[0]!.resuming_lease_owner).toBe("owner-C");
  }, PG_TEST_TIMEOUT_MS);

  // #3748 (ADR-0020 phase 3) — approval-park, executed against real Postgres.
  // Pins the parked upsert, the max-park sweep (interval math), the resolution
  // flip, and — the load-bearing behavior change — that the crash-resume claim
  // does NOT pick up a `parked` run (it awaits a human decision, not a crash).
  async function newConversation(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
    );
    return rows[0]!.id;
  }

  it("#3748: the parked upsert flips a run to parked with parked_reason", async () => {
    const conversationId = await newConversation();
    const runId = "55555555-5555-5555-5555-555555555555";
    await pool.query(RUNNING_UPSERT_SQL, [
      runId, conversationId, "org-1", "running", 1,
      JSON.stringify([{ role: "assistant", content: "mid" }]),
    ]);
    await pool.query(PARKED_UPSERT_SQL, [
      runId, conversationId, "org-1", "parked", 1,
      JSON.stringify([{ role: "tool", content: "needs-approval" }]),
      "req-42",
    ]);
    const row = await pool.query<{ status: string; parked_reason: string; transcript: unknown }>(
      `SELECT status, parked_reason, transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.status).toBe("parked");
    expect(row.rows[0]!.parked_reason).toBe("req-42");
    expect(row.rows[0]!.transcript).toEqual([{ role: "tool", content: "needs-approval" }]);
  }, PG_TEST_TIMEOUT_MS);

  it("#3748: the parked upsert never resurrects a terminal run (out-of-order write guard)", async () => {
    const conversationId = await newConversation();
    const runId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    // A turn that already finished `done` (the terminal write landed first).
    await pool.query(TERMINAL_UPSERT_SQL, [
      runId, conversationId, "org-1", "done", 3,
      JSON.stringify([{ role: "assistant", content: "final answer" }]),
    ]);
    // A stale/reordered `parked` write for the same run must be a no-op — the
    // `WHERE status NOT IN ('done','failed')` guard stops it resurrecting the row.
    await pool.query(PARKED_UPSERT_SQL, [
      runId, conversationId, "org-1", "parked", 2,
      JSON.stringify([{ role: "tool", content: "needs-approval" }]),
      "req-late",
    ]);
    const row = await pool.query<{ status: string; parked_reason: string | null; transcript: unknown }>(
      `SELECT status, parked_reason, transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(row.rows[0]!.status).toBe("done"); // unchanged — not flipped back to parked
    expect(row.rows[0]!.parked_reason).toBeNull();
    expect(row.rows[0]!.transcript).toEqual([{ role: "assistant", content: "final answer" }]);
  }, PG_TEST_TIMEOUT_MS);

  it("#3748: the crash-resume claim never picks up a parked run", async () => {
    const conversationId = await newConversation();
    const runId = "66666666-6666-6666-6666-666666666666";
    await pool.query(PARKED_UPSERT_SQL, [
      runId, conversationId, "org-1", "parked", 1,
      JSON.stringify([{ role: "tool", content: "needs-approval" }]),
      "req-77",
    ]);
    // A parked run is awaiting a human approval decision — the claim must skip it.
    const claim = await pool.query(RESUME_CLAIM_SQL, [conversationId, "300", "owner-A"]);
    expect(claim.rowCount).toBe(0);
    // It only becomes claimable once resolution flips it back to running.
    await pool.query(PARKED_RESOLVE_SQL, [
      runId, JSON.stringify([{ role: "tool", content: "approved" }]), 1,
    ]);
    const claim2 = await pool.query(RESUME_CLAIM_SQL, [conversationId, "300", "owner-B"]);
    expect(claim2.rowCount).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("#3748: resolution flips parked → running, rewrites transcript, clears parked_reason", async () => {
    const conversationId = await newConversation();
    const runId = "77777777-7777-7777-7777-777777777777";
    await pool.query(PARKED_UPSERT_SQL, [
      runId, conversationId, "org-1", "parked", 2,
      JSON.stringify([{ role: "tool", content: "needs-approval" }]),
      "req-88",
    ]);
    const first = await pool.query(PARKED_RESOLVE_SQL, [
      runId, JSON.stringify([{ role: "tool", content: "approved" }]), 2,
    ]);
    expect(first.rowCount).toBe(1);
    const row = await pool.query<{ status: string; parked_reason: string | null; transcript: unknown }>(
      `SELECT status, parked_reason, transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(row.rows[0]!.status).toBe("running");
    expect(row.rows[0]!.parked_reason).toBeNull();
    expect(row.rows[0]!.transcript).toEqual([{ role: "tool", content: "approved" }]);

    // Double-resolution is a no-op: the `status = 'parked'` guard matches nothing
    // now (the row is already running), so a retried/concurrent review can't
    // resurrect it or clobber the resumed transcript.
    const second = await pool.query(PARKED_RESOLVE_SQL, [
      runId, JSON.stringify([{ role: "tool", content: "STALE" }]), 2,
    ]);
    expect(second.rowCount).toBe(0);
    const afterSecond = await pool.query<{ transcript: unknown }>(
      `SELECT transcript FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(afterSecond.rows[0]!.transcript).toEqual([{ role: "tool", content: "approved" }]);
  }, PG_TEST_TIMEOUT_MS);

  it("#3748: the max-park sweep fails only parked runs past the window", async () => {
    const conversationId = await newConversation();
    const staleRun = "88888888-8888-8888-8888-888888888888";
    const freshRun = "99999999-9999-9999-9999-999999999999";
    const runningRun = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    // A parked run that parked 2 hours ago (past a 60-minute window).
    await pool.query(PARKED_UPSERT_SQL, [
      staleRun, conversationId, "org-1", "parked", 1, JSON.stringify([]), "req-old",
    ]);
    await pool.query(
      `UPDATE agent_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`,
      [staleRun],
    );
    // A freshly parked run (inside the window) and a running run (never swept).
    await pool.query(PARKED_UPSERT_SQL, [
      freshRun, conversationId, "org-1", "parked", 1, JSON.stringify([]), "req-new",
    ]);
    await pool.query(RUNNING_UPSERT_SQL, [
      runningRun, conversationId, "org-1", "running", 1, JSON.stringify([]),
    ]);

    const swept = await pool.query(PARKED_SWEEP_SQL, ["60"]);
    expect(swept.rowCount).toBe(1); // only the stale parked run

    const statuses = await pool.query<{ id: string; status: string; parked_reason: string | null }>(
      `SELECT id, status, parked_reason FROM agent_runs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[staleRun, freshRun, runningRun]],
    );
    const byId = new Map(statuses.rows.map((r) => [r.id, r]));
    expect(byId.get(staleRun)!.status).toBe("failed");
    expect(byId.get(staleRun)!.parked_reason).toBeNull(); // cleared on sweep
    expect(byId.get(freshRun)!.status).toBe("parked"); // still inside the window
    expect(byId.get(runningRun)!.status).toBe("running"); // never a sweep target
  }, PG_TEST_TIMEOUT_MS);

  it("#3748: the max-park sweep respects the window boundary (strict <, no off-by-one)", async () => {
    const conversationId = await newConversation();
    const justOutside = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // 61 min — must sweep
    const justInside = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // 59 min — must NOT sweep

    for (const [runId, ref, ageMinutes] of [
      [justOutside, "req-61", 61],
      [justInside, "req-59", 59],
    ] as const) {
      await pool.query(PARKED_UPSERT_SQL, [
        runId, conversationId, "org-1", "parked", 1, JSON.stringify([]), ref,
      ]);
      await pool.query(
        `UPDATE agent_runs SET updated_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
        [runId, String(ageMinutes)],
      );
    }

    // One sweep with a 60-minute window: the SQL is `updated_at < now() - 60min`
    // (strict `<`), so only the 61-min run crosses the boundary.
    const swept = await pool.query(PARKED_SWEEP_SQL, ["60"]);
    expect(swept.rowCount).toBe(1);

    const rows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_runs WHERE id = ANY($1::uuid[])`,
      [[justOutside, justInside]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(byId.get(justOutside)).toBe("failed"); // past the window → swept
    expect(byId.get(justInside)).toBe("parked"); // inside the window → kept
  }, PG_TEST_TIMEOUT_MS);

  it("#3748 (0146): the parked⟺parked_reason CHECK rejects a reason-less parked row", async () => {
    const conversationId = await newConversation();
    const runId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

    // A `parked` row MUST carry the approval-queue ref — the only link back to the
    // suspended turn. A direct insert without one violates chk_agent_runs_parked_reason.
    await expect(
      pool.query(
        `INSERT INTO agent_runs (id, conversation_id, org_id, status, step_index, transcript)
           VALUES ($1, $2, 'org-1', 'parked', 1, '[]'::jsonb)`,
        [runId, conversationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Flipping an existing running row to parked without a reason is likewise rejected
    // (so a buggy write path can't strand a reason-less, un-resolvable parked zombie).
    await pool.query(RUNNING_UPSERT_SQL, [
      runId, conversationId, "org-1", "running", 1, JSON.stringify([]),
    ]);
    await expect(
      pool.query(`UPDATE agent_runs SET status = 'parked' WHERE id = $1`, [runId]),
    ).rejects.toMatchObject({ code: "23514" });

    // The CHECK only constrains `parked` — a running/done/failed row may have a NULL
    // parked_reason, so the row above is untouched and still running.
    const after = await pool.query<{ status: string; parked_reason: string | null }>(
      `SELECT status, parked_reason FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(after.rows[0]!.status).toBe("running");
    expect(after.rows[0]!.parked_reason).toBeNull();
  }, PG_TEST_TIMEOUT_MS);

  // #3757 (ADR-0020 slice 4) — working memory is swept WITH its session. The
  // sweep dates a session by its newest `agent_runs` row, deletes memory for
  // sessions whose runs are all terminal + past the window, and NEVER touches a
  // session with a live (running/parked) run. Exercises the EXACT
  // SESSION_MEMORY_SWEEP_SQL the helper runs against real Postgres (the EXISTS /
  // NOT EXISTS / max(updated_at) interval math a mock pool can't validate).
  async function seedMemory(conversationId: string, namespace: string, value: unknown) {
    await pool.query(SESSION_MEMORY_UPSERT_SQL, [
      conversationId,
      "org-1",
      namespace,
      JSON.stringify(value ?? null),
    ]);
  }

  it("#3757: sweeps memory for an expired terminal session, keeps a fresh one", async () => {
    const expired = await newConversation();
    const fresh = await newConversation();

    // Expired session: one terminal run aged past a 7-day window + a memory slot.
    await pool.query(TERMINAL_UPSERT_SQL, [
      "10000000-0000-0000-0000-000000000001", expired, "org-1", "done", 1, JSON.stringify([]),
    ]);
    await pool.query(
      `UPDATE agent_runs SET updated_at = now() - interval '8 days' WHERE conversation_id = $1`,
      [expired],
    );
    await seedMemory(expired, "region", "EU");

    // Fresh session: a terminal run inside the window + a memory slot.
    await pool.query(TERMINAL_UPSERT_SQL, [
      "10000000-0000-0000-0000-000000000002", fresh, "org-1", "done", 1, JSON.stringify([]),
    ]);
    await seedMemory(fresh, "table", "orders");

    const swept = await pool.query<{ conversation_id: string }>(SESSION_MEMORY_SWEEP_SQL, ["7"]);
    expect(swept.rows.map((r) => r.conversation_id)).toEqual([expired]);

    // The expired session's memory is gone; the fresh session's memory survives.
    const remaining = await pool.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM agent_session_memory WHERE conversation_id = ANY($1::uuid[]) ORDER BY conversation_id`,
      [[expired, fresh]],
    );
    expect(remaining.rows.map((r) => r.conversation_id)).toEqual([fresh]);
  }, PG_TEST_TIMEOUT_MS);

  it("#3757: never sweeps memory for a session with a live (running/parked) run, even if old", async () => {
    const stillRunning = await newConversation();
    const stillParked = await newConversation();

    // A session whose newest run is `running`, aged well past the window: its
    // memory is the LIVE working set and must NOT be swept.
    await pool.query(RUNNING_UPSERT_SQL, [
      "20000000-0000-0000-0000-000000000001", stillRunning, "org-1", "running", 1, JSON.stringify([]),
    ]);
    await pool.query(
      `UPDATE agent_runs SET updated_at = now() - interval '30 days' WHERE conversation_id = $1`,
      [stillRunning],
    );
    await seedMemory(stillRunning, "ctx", "live");

    // A session parked awaiting approval, also old: still non-terminal → kept.
    await pool.query(PARKED_UPSERT_SQL, [
      "20000000-0000-0000-0000-000000000002", stillParked, "org-1", "parked", 1, JSON.stringify([]), "req-x",
    ]);
    await pool.query(
      `UPDATE agent_runs SET updated_at = now() - interval '30 days' WHERE conversation_id = $1`,
      [stillParked],
    );
    await seedMemory(stillParked, "ctx", "awaiting");

    const swept = await pool.query(SESSION_MEMORY_SWEEP_SQL, ["7"]);
    expect(swept.rowCount).toBe(0);

    const remaining = await pool.query<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id FROM agent_session_memory WHERE conversation_id = ANY($1::uuid[]) ORDER BY conversation_id`,
      [[stillRunning, stillParked].sort()],
    );
    expect(remaining.rowCount).toBe(2); // both kept
  }, PG_TEST_TIMEOUT_MS);

  it("#3757: the FK cascade also removes memory when the conversation is deleted", async () => {
    const conversationId = await newConversation();
    await seedMemory(conversationId, "region", "EU");
    // Deleting the conversation cascades to its memory (migration 0145 FK) — the
    // second leg of "swept with its session" for the conversation-delete path.
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
    const remaining = await pool.query(
      `SELECT 1 FROM agent_session_memory WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(remaining.rowCount).toBe(0);
  }, PG_TEST_TIMEOUT_MS);
});

// #2606 — source-level revert guard for the integration-store SQL formatter.
// Lives outside `describeIfPg` so it runs in every shard, including dev
// without TEST_DATABASE_URL — fails in milliseconds if any store reverts
// to `installed_at::text` (the format Zod's strict .datetime() rejects).
describe("integration stores: ISO timestamp SQL", () => {
  it("no store reintroduces installed_at::text", () => {
    // gchat/teams/telegram/whatsapp stores were deleted in #3161 (their tables
    // dropped by migration 0119) — only the surviving stores are checked.
    const platforms = ["discord", "email", "github", "linear", "slack"] as const;
    for (const platform of platforms) {
      const source = readFileSync(join(import.meta.dir, "..", "..", platform, "store.ts"), "utf8");
      expect(source).not.toContain("installed_at::text");
    }
  });
});
