/**
 * Real-Postgres coverage for the form-install spine's upsert. Mirrors
 * the `migrate-pg.test.ts` harness (per the `billing/__tests__/
 * chat-cap-pg.test.ts` precedent for module-colocated real-PG contract
 * tests): skips cleanly when `TEST_DATABASE_URL` is unset, runs every
 * migration into a unique per-test schema, and executes
 * {@link buildFormInstallUpsertSql} VERBATIM against the live schema.
 *
 * What this catches that the mock-pool spine/handler tests can't:
 * plan-time SQL errors. The pre-spine Email/Webhook/Obsidian handlers
 * carried a pre-0092 INSERT (no install_id/pillar, bare `ON CONFLICT
 * (workspace_id, catalog_id)`) that relied on the 0092 BEFORE INSERT
 * trigger and the global unique index, BOTH dropped by 0096 — every
 * install attempt failed with 42P10 at plan time, invisible behind
 * mocked `internalQuery`. (The schema-side 42P10 pin for the legacy
 * shape lives in `db/__tests__/migrate-pg.test.ts`, where pure schema
 * properties belong.)
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { buildFormInstallUpsertSql } from "../persist-form-install";
import {
  SALESFORCE_CATALOG_ID,
  SALESFORCE_LEGACY_PILLAR_CONVERGE_SQL,
} from "../salesforce-oauth-handler";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// Full migration set + queries can take several seconds on shared CI
// runners (matches migrate-pg.test.ts's budget).
const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("form-install spine: workspace_plugins upsert against the live schema", () => {
  let pool: Pool;
  const schemaName = `spine_pg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`spine-pg: SET search_path failed on new connection: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Catalog rows aren't seeded by migrations (catalog-seeder runs at
    // boot) — seed FK targets for both pillars the builder emits.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES
         ('catalog:spine-email', 'Email', 'spine-email', 'integration', 'action', 'form'),
         ('catalog:spine-chat',  'Chat',  'spine-chat',  'chat',        'chat',   'static-bot')
       ON CONFLICT (id) DO NOTHING`,
    );
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`spine-pg: schema cleanup failed: ${message}`);
    });
    await pool.end();
  });

  it("action pillar: both variants plan + execute, and the conflict path returns the existing row id", async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-spine-${stamp}`;

    // Fresh INSERT (config-updating variant) — returns the candidate id.
    const fresh = await pool.query<{ id: string }>(buildFormInstallUpsertSql(true), [
      `spine-a-${stamp}`,
      ws,
      "catalog:spine-email",
      JSON.stringify({ host: "smtp.example.com" }),
    ]);
    expect(fresh.rows[0]?.id).toBe(`spine-a-${stamp}`);

    // Re-install (conflict path) — config updates, id stays the
    // existing row's (the returned-id invariant the handlers rely on).
    const conflict = await pool.query<{ id: string }>(buildFormInstallUpsertSql(true), [
      `spine-b-${stamp}`,
      ws,
      "catalog:spine-email",
      JSON.stringify({ host: "smtp2.example.com" }),
    ]);
    expect(conflict.rows[0]?.id).toBe(`spine-a-${stamp}`);

    // Non-config-updating variant (Twenty) — keeps the stored config.
    const stub = await pool.query<{ id: string }>(buildFormInstallUpsertSql(false), [
      `spine-c-${stamp}`,
      ws,
      "catalog:spine-email",
      JSON.stringify({}),
    ]);
    expect(stub.rows[0]?.id).toBe(`spine-a-${stamp}`);

    const { rows } = await pool.query<{
      install_id: string;
      pillar: string;
      config: { host?: string };
      enabled: boolean;
      status: string;
    }>(
      `SELECT install_id, pillar, config, enabled, status
         FROM workspace_plugins WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.install_id).toBe(`spine-a-${stamp}`);
    expect(rows[0]?.pillar).toBe("action");
    // The stub variant did NOT clobber the config the second install wrote.
    expect(rows[0]?.config.host).toBe("smtp2.example.com");
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.status).toBe("published");
  }, PG_TEST_TIMEOUT_MS);

  it("chat pillar variant plans + executes with the same singleton semantics", async () => {
    // No form handler writes 'chat' yet — the parameter exists so the
    // five static-bot handlers and the #3357 OAuth fix can converge on
    // this tested artifact. Pin it against the live schema now so the
    // first consumer inherits a known-good string.
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-spine-chat-${stamp}`;

    const fresh = await pool.query<{ id: string }>(buildFormInstallUpsertSql(true, "chat"), [
      `chat-a-${stamp}`,
      ws,
      "catalog:spine-chat",
      JSON.stringify({ chat_id: stamp }),
    ]);
    expect(fresh.rows[0]?.id).toBe(`chat-a-${stamp}`);

    const conflict = await pool.query<{ id: string }>(buildFormInstallUpsertSql(true, "chat"), [
      `chat-b-${stamp}`,
      ws,
      "catalog:spine-chat",
      JSON.stringify({ chat_id: `${stamp}-rotated` }),
    ]);
    expect(conflict.rows[0]?.id).toBe(`chat-a-${stamp}`);

    const { rows } = await pool.query<{ pillar: string; config: { chat_id?: string } }>(
      `SELECT pillar, config FROM workspace_plugins WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pillar).toBe("chat");
    expect(rows[0]?.config.chat_id).toBe(`${stamp}-rotated`);
  }, PG_TEST_TIMEOUT_MS);

  it("salesforce legacy-pillar converge heals a pre-0096 datasource row so the upsert dedupes (#3362)", async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const ws = `ws-sf-converge-${stamp}`;
    const legacyId = `legacy-${stamp}`;

    // The legacy shape: pre-0096 Salesforce OAuth installs carry
    // pillar='datasource' with the install_id = catalog_id sentinel
    // (0092 backfill; migration 0103 converged only the catalog row).
    await pool.query(
      `INSERT INTO workspace_plugins
         (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
       VALUES ($1, $2, $3, $3, 'datasource',
               '{"instance_url":"https://old.my.salesforce.com"}'::jsonb, true, NOW())`,
      [legacyId, ws, SALESFORCE_CATALOG_ID],
    );

    // Converge runs on every OAuth callback — twice here to pin
    // idempotence (the NOT EXISTS guard makes the second run a no-op
    // rather than a singleton-index violation).
    await pool.query(SALESFORCE_LEGACY_PILLAR_CONVERGE_SQL, [ws, SALESFORCE_CATALOG_ID]);
    await pool.query(SALESFORCE_LEGACY_PILLAR_CONVERGE_SQL, [ws, SALESFORCE_CATALOG_ID]);

    // The handler's upsert must now take the conflict path against the
    // converged row: same id back, ONE row total, fresh config.
    const upsert = await pool.query<{ id: string }>(buildFormInstallUpsertSql(true), [
      `cand-${stamp}`,
      ws,
      SALESFORCE_CATALOG_ID,
      JSON.stringify({ instance_url: "https://new.my.salesforce.com" }),
    ]);
    expect(upsert.rows[0]?.id).toBe(legacyId);

    const rows = await pool.query<{ id: string; pillar: string; iu: string }>(
      `SELECT id, pillar, config->>'instance_url' AS iu
         FROM workspace_plugins
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [ws, SALESFORCE_CATALOG_ID],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.pillar).toBe("action");
    expect(rows.rows[0]?.iu).toBe("https://new.my.salesforce.com");
  }, PG_TEST_TIMEOUT_MS);
});
