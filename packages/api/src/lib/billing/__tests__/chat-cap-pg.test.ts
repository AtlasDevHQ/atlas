/**
 * Real-Postgres coverage for the chat-integration cap (#2999 / #2995 AC3 /
 * #3001 AC2). Mirrors the `migrate-pg.test.ts` harness: skips cleanly when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and exercises behaviour that mock-pool tests can't see.
 *
 * What this catches that the mock-based `enforcement.test.ts` can't:
 *   - #2999 — the `CHAT_INTEGRATION_COUNT_SQL` aggregate is never executed by
 *     the unit tests (they script the count rows). A typo in the FILTER
 *     predicate, an inverted `<>`/`=`, or a dropped `status <> 'archived'`
 *     would pass every unit test. Here the real aggregate runs against seeded
 *     mixed-pillar rows.
 *   - #2995 AC3 — the chat-install handlers' `workspace_plugins` INSERT is only
 *     asserted as a SQL *string* by the handler unit tests. Here the real
 *     Discord handler's UPSERT runs against the real post-0096 schema, so a
 *     NOT-NULL `pillar`/`install_id` regression or a stale `ON CONFLICT`
 *     arbiter is caught.
 *   - #3001 AC2 — two concurrent net-new installs at cap-minus-1: the
 *     per-workspace `pg_advisory_xact_lock` must let exactly one through.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import type { WorkspaceId } from "@useatlas/types";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import {
  CHAT_INTEGRATION_COUNT_SQL,
  checkChatIntegrationLimitAndInstall,
  invalidatePlanCache,
} from "@atlas/api/lib/billing/enforcement";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// The full migration set + transactional gate work can take several seconds on
// shared CI runners (matches migrate-pg.test.ts's 30s budget).
const PG_TEST_TIMEOUT_MS = 30_000;

/** Seed a `plugin_catalog` row so `workspace_plugins.catalog_id` FK resolves. */
async function seedCatalog(
  pool: Pool,
  slug: string,
  pillar: "chat" | "action",
): Promise<void> {
  await pool.query(
    `INSERT INTO plugin_catalog (id, name, slug, type, pillar)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [`catalog:${slug}`, slug, slug, pillar],
  );
}

/** Seed a `workspace_plugins` row with explicit pillar + status. */
async function seedInstall(
  pool: Pool,
  opts: {
    id: string;
    workspaceId: string;
    catalog: string;
    pillar: "chat" | "action";
    status?: "published" | "draft" | "archived";
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at)
     VALUES ($1, $2, $3, $1, $4, '{}'::jsonb, true, $5, NOW())`,
    [opts.id, opts.workspaceId, opts.catalog, opts.pillar, opts.status ?? "published"],
  );
}

// ---------------------------------------------------------------------------
// #2999 — CHAT_INTEGRATION_COUNT_SQL aggregate
// ---------------------------------------------------------------------------

describeIfPg("CHAT_INTEGRATION_COUNT_SQL (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `chat_cap_count_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`chat-cap-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Catalog rows for every platform referenced below (FK targets).
    await seedCatalog(pool, "slack", "chat");
    await seedCatalog(pool, "discord", "chat");
    await seedCatalog(pool, "telegram", "chat");
    await seedCatalog(pool, "gchat", "chat");
    await seedCatalog(pool, "jira", "action");
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it(
    "counts others vs this_count, excluding action / archived / other-workspace rows (#2999)",
    async () => {
      const ws = `ws-count-${Date.now()}`;
      const otherWs = `ws-other-${Date.now()}`;
      // Workspace under test:
      await seedInstall(pool, { id: `${ws}-slack`, workspaceId: ws, catalog: "catalog:slack", pillar: "chat" });
      await seedInstall(pool, { id: `${ws}-discord`, workspaceId: ws, catalog: "catalog:discord", pillar: "chat" });
      await seedInstall(pool, { id: `${ws}-telegram`, workspaceId: ws, catalog: "catalog:telegram", pillar: "chat" });
      // Action pillar — must NOT count toward the chat cap.
      await seedInstall(pool, { id: `${ws}-jira`, workspaceId: ws, catalog: "catalog:jira", pillar: "action" });
      // Archived chat — must NOT count.
      await seedInstall(pool, { id: `${ws}-gchat`, workspaceId: ws, catalog: "catalog:gchat", pillar: "chat", status: "archived" });
      // Different workspace's chat — must NOT count.
      await seedInstall(pool, { id: `${otherWs}-slack`, workspaceId: otherWs, catalog: "catalog:slack", pillar: "chat" });

      // Reconnect case — Slack IS installed for this workspace.
      const reconnect = await pool.query<{ others: number; this_count: number }>(
        CHAT_INTEGRATION_COUNT_SQL,
        [ws, "catalog:slack"],
      );
      // others = discord + telegram (2); this_count = slack (1). Action,
      // archived, and the other workspace's row are all excluded.
      expect(reconnect.rows[0]?.others).toBe(2);
      expect(reconnect.rows[0]?.this_count).toBe(1);

      // Net-new case — WhatsApp is NOT installed for this workspace.
      const netNew = await pool.query<{ others: number; this_count: number }>(
        CHAT_INTEGRATION_COUNT_SQL,
        [ws, "catalog:whatsapp"],
      );
      // others = slack + discord + telegram (3); this_count = 0 (none installed
      // for whatsapp). Action/archived/other-workspace still excluded.
      expect(netNew.rows[0]?.others).toBe(3);
      expect(netNew.rows[0]?.this_count).toBe(0);

      // Integer typing — `::int` casts must return JS numbers, not strings.
      expect(typeof reconnect.rows[0]?.others).toBe("number");
    },
    PG_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// #2995 AC3 + #3001 AC2 — the atomic gate against the real schema
//
// Wires the gate's module pool (`getInternalDB()` / `internalQuery`) to this
// test's scratch-schema pool via `_resetPool`, and sets `DATABASE_URL` so
// `hasInternalDB()` is true. A minimal `organization` table backs the plan-tier
// lookup (`getWorkspaceDetails`); Better-Auth owns it in production, so it is
// not in our migration set.
// ---------------------------------------------------------------------------

describeIfPg("checkChatIntegrationLimitAndInstall (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `chat_cap_gate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_FETCH = globalThis.fetch;

  /** Slack-handler-shaped UPSERT (mirrors slack-oauth-handler.ts). */
  function slackInsert(installId: string, ws: string) {
    return {
      sql: `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action') DO UPDATE
           SET config = EXCLUDED.config, enabled = true`,
      params: [installId, ws, "catalog:slack", JSON.stringify({ team_id: "T1" })],
    };
  }

  /** Discord-handler-shaped UPSERT with RETURNING id (mirrors discord-static-bot-handler.ts). */
  function discordInsert(installId: string, ws: string) {
    return {
      sql: `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE SET config = EXCLUDED.config, enabled = true
         RETURNING id`,
      params: [installId, ws, "catalog:discord", JSON.stringify({ guild_id: "G1" })],
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`chat-cap-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Minimal `organization` — only the columns getWorkspaceDetails reads.
    await pool.query(
      `CREATE TABLE organization (
         id text PRIMARY KEY,
         name text,
         slug text,
         workspace_status text NOT NULL DEFAULT 'active',
         plan_tier text NOT NULL DEFAULT 'free',
         byot boolean NOT NULL DEFAULT false,
         stripe_customer_id text,
         trial_ends_at timestamptz,
         suspended_at timestamptz,
         deleted_at timestamptz,
         region text,
         region_assigned_at timestamptz,
         "createdAt" timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await seedCatalog(pool, "slack", "chat");
    await seedCatalog(pool, "discord", "chat");
    await seedCatalog(pool, "telegram", "chat");

    // Point the gate's module pool at this scratch-schema pool.
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    globalThis.fetch = ORIGINAL_FETCH;
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    invalidatePlanCache();
    globalThis.fetch = ORIGINAL_FETCH;
    await pool.query(`DELETE FROM workspace_plugins`);
    await pool.query(`DELETE FROM organization`);
  });

  /** Seed an organization row with the given plan tier. */
  async function seedOrg(id: string, planTier: string): Promise<void> {
    await pool.query(
      `INSERT INTO organization (id, name, slug, plan_tier) VALUES ($1, $1, $1, $2)`,
      [id, planTier],
    );
  }

  it(
    "commits the chat-install UPSERT against the real post-0096 schema (#2995 AC3)",
    async () => {
      // No organization row → the gate treats the workspace as pre-migration
      // and allows, so this isolates the INSERT's schema-compatibility: the
      // NOT-NULL pillar/install_id columns and the partial-index ON CONFLICT
      // arbiter must all be valid against the live schema.
      const ws = `ws-insert-${Date.now()}`;
      const gate = await checkChatIntegrationLimitAndInstall<{ id: string }>(
        ws,
        "catalog:slack",
        slackInsert(`${ws}-slack`, ws),
      );
      expect(gate.allowed).toBe(true);

      const { rows } = await pool.query<{
        pillar: string;
        install_id: string;
        status: string;
        catalog_id: string;
      }>(
        `SELECT pillar, install_id, status, catalog_id FROM workspace_plugins WHERE workspace_id = $1`,
        [ws],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.pillar).toBe("chat");
      expect(rows[0]?.install_id).toBe(`${ws}-slack`);
      expect(rows[0]?.status).toBe("published");
      expect(rows[0]?.catalog_id).toBe("catalog:slack");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "runs the real Discord handler UPSERT end-to-end against real Postgres (#2995 AC3)",
    async () => {
      // Exercises the ACTUAL handler code path (validate → reachability → gate
      // → INSERT) so handler↔schema drift on the live INSERT is caught, not a
      // test-local copy. fetch is stubbed for the reachability round-trip.
      const { DiscordStaticBotInstallHandler } = await import(
        "../../integrations/install/discord-static-bot-handler"
      );
      const guildId = "123456789012345678";
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: guildId, name: "Acme" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      const ws = `ws-discord-${Date.now()}`;
      const handler = new DiscordStaticBotInstallHandler({
        botToken: "tkn",
        clientId: "111",
        idGenerator: () => `${ws}-candidate`,
      });

      // First install commits a row.
      const first = await handler.confirmInstall(ws as WorkspaceId, guildId);
      expect(first.installRecord.catalogId).toBe("discord");

      const afterFirst = await pool.query<{ id: string; config: { guild_name?: string } }>(
        `SELECT id, config FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = 'catalog:discord'`,
        [ws],
      );
      expect(afterFirst.rows).toHaveLength(1);
      const persistedId = afterFirst.rows[0]!.id;
      expect(first.installRecord.id).toBe(persistedId);

      // Reconnect (same workspace + guild, new name) UPSERTs the same row.
      const second = await handler.confirmInstall(ws as WorkspaceId, guildId, undefined, {
        guild_name: "Acme Renamed",
      });
      expect(second.installRecord.id).toBe(persistedId);

      const afterSecond = await pool.query<{ id: string }>(
        `SELECT id FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = 'catalog:discord'`,
        [ws],
      );
      // Idempotent — still exactly one row, same id.
      expect(afterSecond.rows).toHaveLength(1);
      expect(afterSecond.rows[0]?.id).toBe(persistedId);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "blocks a net-new platform at the cap and rolls back (no row written)",
    async () => {
      const ws = `ws-cap-${Date.now()}`;
      await seedOrg(ws, "starter"); // maxChatIntegrations = 1
      // One chat platform already installed → the slot is full.
      await seedInstall(pool, {
        id: `${ws}-telegram`,
        workspaceId: ws,
        catalog: "catalog:telegram",
        pillar: "chat",
      });

      const gate = await checkChatIntegrationLimitAndInstall<{ id: string }>(
        ws,
        "catalog:slack",
        slackInsert(`${ws}-slack`, ws),
      );
      expect(gate.allowed).toBe(false);
      if (!gate.allowed) expect(gate.reason).toBe("cap_reached");

      // The INSERT was rolled back — Slack never landed; only telegram remains.
      const { rows } = await pool.query<{ catalog_id: string }>(
        `SELECT catalog_id FROM workspace_plugins WHERE workspace_id = $1 ORDER BY catalog_id`,
        [ws],
      );
      expect(rows.map((r) => r.catalog_id)).toEqual(["catalog:telegram"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "two concurrent net-new installs at cap-minus-1 — exactly one succeeds (#3001 AC2)",
    async () => {
      const ws = `ws-race-${Date.now()}`;
      await seedOrg(ws, "starter"); // cap = 1, zero installed → exactly one free slot

      // Slack + Discord OAuth callbacks completing in the same window. Without
      // the per-workspace advisory lock both would count 0 and both insert,
      // landing the workspace at 2 (over the cap of 1). With the lock the
      // second blocks, recounts 1, and is refused.
      const [slack, discord] = await Promise.all([
        checkChatIntegrationLimitAndInstall<{ id: string }>(
          ws,
          "catalog:slack",
          slackInsert(`${ws}-slack`, ws),
        ),
        checkChatIntegrationLimitAndInstall<{ id: string }>(
          ws,
          "catalog:discord",
          discordInsert(`${ws}-discord`, ws),
        ),
      ]);

      const allowed = [slack, discord].filter((r) => r.allowed);
      const denied = [slack, discord].filter((r) => !r.allowed);
      expect(allowed).toHaveLength(1);
      expect(denied).toHaveLength(1);
      const deniedResult = denied[0]!;
      expect(deniedResult.allowed).toBe(false);
      // The loser is refused for the cap (429 "upgrade"), not a transient blip.
      if (!deniedResult.allowed) expect(deniedResult.reason).toBe("cap_reached");

      // The DB holds exactly one chat install for the workspace.
      const { rows } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM workspace_plugins WHERE workspace_id = $1 AND pillar = 'chat'`,
        [ws],
      );
      expect(rows[0]?.n).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "two concurrent SAME-platform installs at cap — both succeed, collapse to one row",
    async () => {
      const ws = `ws-same-${Date.now()}`;
      await seedOrg(ws, "starter"); // cap = 1, zero installed

      // The docstring claims the same-platform case was always safe — the
      // singleton partial unique index collapses the duplicate into an UPSERT.
      // Prove it under real contention: two concurrent Slack installs serialize
      // on the advisory lock; the first lands net-new (allowed), the second
      // recounts this_count=1 → reconnect → skips the cap → UPSERTs the same
      // (workspace, catalog) row. Both allowed, exactly one row.
      const [a, b] = await Promise.all([
        checkChatIntegrationLimitAndInstall<{ id: string }>(
          ws,
          "catalog:slack",
          slackInsert(`${ws}-slack-a`, ws),
        ),
        checkChatIntegrationLimitAndInstall<{ id: string }>(
          ws,
          "catalog:slack",
          slackInsert(`${ws}-slack-b`, ws),
        ),
      ]);

      expect(a.allowed).toBe(true);
      expect(b.allowed).toBe(true);

      // Exactly one Slack row — the second install collapsed onto the first via
      // ON CONFLICT, never breaching the cap.
      const { rows } = await pool.query<{ catalog_id: string }>(
        `SELECT catalog_id FROM workspace_plugins WHERE workspace_id = $1 AND pillar = 'chat'`,
        [ws],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.catalog_id).toBe("catalog:slack");
    },
    PG_TEST_TIMEOUT_MS,
  );
});
