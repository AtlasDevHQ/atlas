/**
 * Residue-sweep falsifier against a real Postgres (#5185).
 *
 * The AC this exists to satisfy, quoted: *"A sentinel denylist is mandatory and
 * tested — a fixture seeding `_default` / `<atlas-operator>` / `` asserts they
 * are never selected. This is the whole risk of the command."*
 *
 * `residue-sweep.test.ts` pins the classifier on hand-built values; this suite
 * plants the real thing. Every scope value below is one the 2026-08-12 prod
 * sweep actually returned, in the table it returned from, seeded through the
 * real migration set — so what is asserted is that an EXECUTE against a
 * migrated region schema removes the one genuine orphan and leaves the eight
 * sentinels standing, which is exactly the call the command exists to make.
 *
 * Three properties make this able to fail:
 *
 *  1. **The survivors are seeded with real rows and their counts asserted.**
 *     A sentinel assertion against an unseeded table passes whether the guard
 *     works or not.
 *  2. **Row counts differ across classes** (3 withheld in `sla_thresholds`, 2 in
 *     `crm_outbox`, 4 deletable in total). With 1/1/1 an implementation that
 *     confused the two lists would still satisfy a totals assertion.
 *  3. **`admin_action_log` (`anonymized`) and `user_trial_grants` (`retained`)
 *     are seeded with orphaned rows too.** Their scope values are NOT sentinels
 *     — `user_trial_grants` carries a plain nanoid — so they survive only
 *     because the candidate set is filtered by `decision: "purged"`. Widening
 *     the sweep to "every workspace-scoped table" deletes both, which is the
 *     failure the registry derivation prevents and no sentinel test can see.
 *
 * A private scratch DATABASE, not a scratch schema: the sweep hardcodes
 * `public` (as `ops wipe` and the runbook query do), and this suite runs a
 * DESTRUCTIVE delete. Pointing it at the shared test database's `public` schema
 * would let a bug here delete a sibling suite's rows.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset. CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  discoverResidueTargets,
  sweepResidue,
  type ResidueQuery,
} from "../residue-sweep";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TIMEOUT_MS = 180_000;

const scratchDbName = `residue_sweep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

/** The live workspace — its rows are the blast-radius control. */
const LIVE_ORG = "orgResidueLive0000000000000000";
/** The genuine prod residue, verbatim from the 2026-08-12 US sweep. */
const RESIDUE_A = "jukFiKym65bnNAYGiY1zdthspoNUYpov";
/** A second orphan, so "deleted the residue" cannot pass by deleting one row. */
const RESIDUE_B = "wsResidueBBBBBBBBBBBBBBBBBBBBBBB";
/** The orphan planted in `retained` / `anonymized` tables, which must SURVIVE. */
const RESIDUE_PROTECTED = "wsProtectedCCCCCCCCCCCCCCCCCCCCC";

/**
 * Minimal Better Auth bootstrap — these tables are global (ADR-0024), not
 * Atlas-owned, so the migration set assumes rather than creates them. Only the
 * columns this fixture needs; migrations extend `organization` themselves.
 */
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

describeIfPg("residue sweep against a migrated region schema", () => {
  let pool: Pool;
  let scratchDbUrl: string;
  let query: ResidueQuery;

  async function countWhere(table: string, column: string, value: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE "${column}" = $1`,
      [value],
    );
    return Number(r.rows[0]?.n ?? "0");
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    try {
      // CREATE DATABASE cannot run inside a transaction, and the target doesn't
      // exist yet — so it runs on a one-shot pool bound to TEST_DATABASE_URL.
      await admin.query(`CREATE DATABASE "${scratchDbName}"`);
    } finally {
      await admin.end().catch((err: unknown) => {
        console.warn(
          `residue-sweep-pg beforeAll: admin pool end failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    const url = new URL(TEST_DB_URL as string);
    url.pathname = `/${scratchDbName}`;
    scratchDbUrl = url.toString();
    pool = new Pool({ connectionString: scratchDbUrl, max: 4 });
    query = (async (sql: string, params?: unknown[]) =>
      (await pool.query(sql, params)).rows) as ResidueQuery;

    await pool.query(BETTER_AUTH_BOOTSTRAP_SQL);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`);
    await pool.query(`INSERT INTO "organization" (id, name, slug) VALUES ($1, $1, $1)`, [LIVE_ORG]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ('u-residue', 'residue@sweep.test')`);
    await runMigrations(pool);

    // ── sla_thresholds: 3 withheld sentinels + 1 orphan + 1 live ────────────
    // `_default` is the deployment-wide default tier the prod sweep flagged in
    // all three regions; `_global` is NOT on the denylist and proves the
    // leading-underscore backstop; `''` is the empty-scope case.
    for (const workspaceId of ["_default", "_global", "", RESIDUE_A, LIVE_ORG]) {
      await pool.query(
        `INSERT INTO sla_thresholds (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId],
      );
    }

    // ── crm_outbox: 2 withheld operator rows + 1 orphan ─────────────────────
    for (const workspaceId of ["<atlas-operator>", "<atlas-operator>", RESIDUE_B]) {
      await pool.query(
        `INSERT INTO crm_outbox (event_type, payload, status, workspace_id)
         VALUES ('demo_lead', '{"email":"x@y.test"}'::jsonb, 'pending', $1)`,
        [workspaceId],
      );
    }

    // ── workspace_proactive_config: the exact prod finding + a live control ──
    for (const workspaceId of [RESIDUE_A, LIVE_ORG]) {
      await pool.query(
        `INSERT INTO workspace_proactive_config (workspace_id) VALUES ($1)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId],
      );
    }

    // ── The decision-filter controls: orphaned rows in non-`purged` tables ──
    // Neither value is a sentinel, so only the `decision: "purged"` filter
    // spares them.
    await pool.query(
      `INSERT INTO admin_action_log (org_id, action_type, target_type, target_id, request_id)
       VALUES ($1, 'workspace.purge', 'workspace', 'target-x', 'req-residue')`,
      [RESIDUE_PROTECTED],
    );
    await pool.query(
      `INSERT INTO user_trial_grants (user_id, org_id) VALUES ('u-residue', $1)`,
      [RESIDUE_PROTECTED],
    );
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end().catch((err: unknown) => {
      console.warn(
        `residue-sweep-pg afterAll: pool end failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
    } catch (err) {
      console.warn(
        `residue-sweep-pg afterAll: DROP DATABASE failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await admin.end().catch((err: unknown) => {
        console.warn(
          `residue-sweep-pg afterAll: admin pool end failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }, PG_TIMEOUT_MS);

  test(
    "discovery reaches the seeded purged tables and skips the non-purged ones",
    async () => {
      const { targets, skipped } = await discoverResidueTargets(query);
      const swept = new Set(targets.map((t) => t.table));

      expect(swept.has("sla_thresholds")).toBe(true);
      expect(swept.has("crm_outbox")).toBe(true);
      expect(swept.has("workspace_proactive_config")).toBe(true);
      // `anonymized` / `retained` never enter the sweep at all — not as a
      // target, and not as a skip either, because they are not candidates.
      const mentioned = new Set([...swept, ...skipped.map((s) => s.table)]);
      expect(mentioned.has("admin_action_log")).toBe(false);
      expect(mentioned.has("user_trial_grants")).toBe(false);
      // `messages` has no scope column of its own — reported, never silent.
      const messages = skipped.find((s) => s.table === "messages");
      expect(messages?.reason).toContain("no workspace scope column");
    },
    PG_TIMEOUT_MS,
  );

  test(
    "DRY RUN classifies the real prod result set and deletes nothing",
    async () => {
      const report = await sweepResidue(query, { dryRun: true });

      const withheld = new Map(report.withheld.map((w) => [`${w.table}:${w.value}`, w]));
      expect(withheld.get("sla_thresholds:_default")?.reason).toContain("default tier row");
      expect(withheld.get("sla_thresholds:_global")?.reason).toContain("by convention");
      expect(withheld.get("sla_thresholds:")?.reason).toContain("admin_action_log");
      expect(withheld.get("crm_outbox:<atlas-operator>")?.reason).toContain("0106");
      expect(withheld.get("crm_outbox:<atlas-operator>")?.rows).toBe(2);

      // Nothing beyond the planted orphans is proposed for deletion. This is
      // the global claim — a widened candidate set or a broken classifier shows
      // up here as an extra value, not as a missing one.
      expect(new Set(report.wouldDelete.map((d) => d.value))).toEqual(
        new Set([RESIDUE_A, RESIDUE_B]),
      );
      // 2 rows for RESIDUE_A (sla_thresholds + workspace_proactive_config),
      // 1 for RESIDUE_B, 3 withheld in sla_thresholds + 2 in crm_outbox.
      expect(report.totals.rowsWouldDelete).toBe(3);
      expect(report.totals.rowsWithheld).toBe(5);
      expect(report.totals.rowsDeleted).toBe(0);

      // The rows are all still there.
      expect(await countWhere("sla_thresholds", "workspace_id", RESIDUE_A)).toBe(1);
      expect(await countWhere("crm_outbox", "workspace_id", RESIDUE_B)).toBe(1);
    },
    PG_TIMEOUT_MS,
  );

  test(
    "EXECUTE deletes the residue and leaves every sentinel standing",
    async () => {
      const report = await sweepResidue(query, { dryRun: false });

      expect(report.errors).toEqual([]);
      expect(report.totals.rowsDeleted).toBe(3);

      // The orphans are gone.
      expect(await countWhere("sla_thresholds", "workspace_id", RESIDUE_A)).toBe(0);
      expect(await countWhere("workspace_proactive_config", "workspace_id", RESIDUE_A)).toBe(0);
      expect(await countWhere("crm_outbox", "workspace_id", RESIDUE_B)).toBe(0);

      // The sentinels are not — with their exact counts, so a delete that took
      // one of the two `<atlas-operator>` rows would fail here.
      expect(await countWhere("sla_thresholds", "workspace_id", "_default")).toBe(1);
      expect(await countWhere("sla_thresholds", "workspace_id", "_global")).toBe(1);
      expect(await countWhere("sla_thresholds", "workspace_id", "")).toBe(1);
      expect(await countWhere("crm_outbox", "workspace_id", "<atlas-operator>")).toBe(2);

      // The live workspace's rows are untouched — the blast-radius control.
      expect(await countWhere("sla_thresholds", "workspace_id", LIVE_ORG)).toBe(1);
      expect(await countWhere("workspace_proactive_config", "workspace_id", LIVE_ORG)).toBe(1);

      // The decision-filter controls: orphaned, non-sentinel, and spared only
      // because their tables are `anonymized` / `retained`.
      expect(await countWhere("admin_action_log", "org_id", RESIDUE_PROTECTED)).toBe(1);
      expect(await countWhere("user_trial_grants", "org_id", RESIDUE_PROTECTED)).toBe(1);
    },
    PG_TIMEOUT_MS,
  );

  test(
    "a second EXECUTE is a no-op — the sweep is idempotent",
    async () => {
      const report = await sweepResidue(query, { dryRun: false });
      expect(report.totals.rowsDeleted).toBe(0);
      expect(report.errors).toEqual([]);
      // Still reported, still refused.
      expect(report.totals.rowsWithheld).toBe(5);
    },
    PG_TIMEOUT_MS,
  );
});
