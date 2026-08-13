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
 * migrated region schema removes the genuine orphans and leaves every sentinel
 * standing, which is exactly the call the command exists to make.
 *
 * Four properties make this able to fail:
 *
 *  1. **`_default` comes from its PRODUCTION ORIGIN, not from this fixture.**
 *     `runSeeds` → `seedSlaThresholdDefaults` is what writes it in a real
 *     region. Hand-inserting the same literal would prove the guard withholds a
 *     string this test wrote, not the string production emits — a fixture
 *     agreeing with the implementation at the origin.
 *  2. **`runSeeds` also plants the NULL-scope rows.** The built-in
 *     `prompt_collections` library rows have `org_id IS NULL`, and
 *     `NOT EXISTS (o.id = NULL)` is TRUE — so without the orphan query's
 *     `IS NOT NULL` they are enumerated as residue and the classifier is handed
 *     a null. That is real prod data, not a contrived row.
 *  3. **Row counts differ across classes** (3 deletable, 6 withheld; 4 withheld
 *     in `sla_thresholds` vs 2 in `crm_outbox`). With 1/1/1 an implementation
 *     that confused the two lists would still satisfy a totals assertion.
 *  4. **`admin_action_log` (`anonymized`) and `user_trial_grants` (`retained`)
 *     are seeded with orphaned rows too.** Their scope values are NOT sentinels
 *     — a plain nanoid — so they survive only because the candidate set is
 *     filtered by `decision: "purged"`. Widening the sweep to "every
 *     workspace-scoped table" deletes both, which no sentinel test can see.
 *
 * A private scratch DATABASE, not a scratch schema: the sweep hardcodes
 * `public` (as `ops wipe` and the runbook query do), and this suite runs a
 * DESTRUCTIVE delete. Pointing it at the shared test database's `public` schema
 * would put a sibling suite's rows in the blast radius.
 *
 * ⚠️ The four tests are ORDER-COUPLED through shared database state:
 * discovery → DRY RUN (asserts rows present) → EXECUTE (deletes them) →
 * idempotency (asserts the delete stuck). bun runs them in declaration order,
 * so a full-file run is correct; `bun test -t "idempotent"` alone is not.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset. Requires a role with
 * CREATEDB (CI's `atlas` role owns the database). CI's api-tests workflow
 * provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { runMigrations, runSeeds } from "@atlas/api/lib/db/migrate";
import {
  discoverResidueTargets,
  isBenignSkip,
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
 * Minimal Better Auth bootstrap. These tables are global (ADR-0024), not
 * Atlas-owned, so the migration set assumes rather than creates them.
 *
 * ⚠️ **The full migration set runs — `MANAGED_AUTH_MIGRATIONS` is NOT skipped
 * here, and that is deliberate rather than an oversight.** Most `-pg` suites do
 * skip it, and this one tried: measured, `runMigrations(pool, { skip:
 * MANAGED_AUTH_MIGRATIONS })` fails with `column "is_operator_workspace" does
 * not exist`, because later Atlas migrations read `organization` columns that
 * the managed-auth set adds. So the choice is this bootstrap plus the full set
 * (what `hard-delete-purge-pg.test.ts` also does), and the drift surface it
 * carries is real: a managed-auth migration that starts touching a column
 * absent below will fail HERE, in CI, after every local gate was green.
 */
const AUTH_BOOTSTRAP_SQL = `
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
  let query: ResidueQuery;

  async function countWhere(table: string, column: string, value: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE "${column}" = $1`,
      [value],
    );
    return Number(r.rows[0]?.n ?? "0");
  }

  async function countNullScope(table: string, column: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE "${column}" IS NULL`,
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
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    query = (async (sql: string, params?: unknown[]) =>
      (await pool.query<Record<string, unknown>>(sql, params)).rows) as ResidueQuery;

    await pool.query(AUTH_BOOTSTRAP_SQL);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`);
    await pool.query(`INSERT INTO "organization" (id, name, slug) VALUES ($1, $1, $1)`, [LIVE_ORG]);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ('u-residue', 'residue@sweep.test')`);
    await runMigrations(pool);
    // The production seed path. It writes `sla_thresholds._default` — the
    // sentinel this suite is about — and the NULL-org `prompt_collections`
    // library rows the IS NOT NULL guard exists for. Neither is hand-planted.
    await runSeeds(pool);

    // ── sla_thresholds: 3 more withheld + 1 orphan + 1 live ─────────────────
    // `_default` is already there from runSeeds. `_global` proves the
    // leading-underscore backstop, `default` the reserved-word arm, `''` the
    // empty-scope case — none of them on the denylist except the last.
    for (const workspaceId of ["_global", "default", "", RESIDUE_A, LIVE_ORG]) {
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
    "discovery reaches the seeded purged tables, skips the non-purged, and reads everything",
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
      expect(messages?.kind).toBe("no-scope-column");
      // The owning role can read every table it can see, so nothing is
      // `unreadable`. This is the assertion that would catch `to_regclass`
      // regressing to the privilege-filtered information_schema probe on a
      // schema where the two disagree.
      expect(skipped.filter((s) => !isBenignSkip(s))).toEqual([]);
    },
    PG_TIMEOUT_MS,
  );

  test(
    "DRY RUN classifies the real prod result set and deletes nothing",
    async () => {
      // The IS NOT NULL guard's real subject: production seed rows, not a
      // contrived fixture. If they were enumerated, `wouldDelete` grows and the
      // classifier is handed a null.
      expect(await countNullScope("prompt_collections", "org_id")).toBeGreaterThan(0);

      const report = await sweepResidue(query, { dryRun: true });

      const withheld = new Map(report.withheld.map((w) => [`${w.table}:${w.value}`, w]));
      // `_default` was written by runSeeds, and carries the DENYLIST's reason —
      // the one no structural arm produces.
      expect(withheld.get("sla_thresholds:_default")?.reason).toContain("default tier row");
      expect(withheld.get("sla_thresholds:_global")?.reason).toContain("by convention");
      expect(withheld.get("sla_thresholds:default")?.reason).toContain("reserved deployment-wide");
      expect(withheld.get("sla_thresholds:")?.reason).toContain("admin_action_log");
      expect(withheld.get("crm_outbox:<atlas-operator>")?.reason).toContain("0106");
      expect(withheld.get("crm_outbox:<atlas-operator>")?.rows).toBe(2);

      // Nothing beyond the planted orphans is proposed for deletion. This is
      // the global claim — a widened candidate set, a dropped NULL guard or a
      // broken classifier shows up here as an extra value, not a missing one.
      expect(new Set(report.wouldDelete.map((d) => d.value))).toEqual(
        new Set([RESIDUE_A, RESIDUE_B]),
      );
      // 2 rows for RESIDUE_A (sla_thresholds + workspace_proactive_config) and
      // 1 for RESIDUE_B; 4 withheld in sla_thresholds + 2 in crm_outbox.
      expect(report.totals.rowsWouldDelete).toBe(3);
      expect(report.totals.rowsWithheld).toBe(6);
      expect(report.totals.rowsDeleted).toBe(0);
      expect(report.totals.tablesUnreadable).toBe(0);
      expect(report.refusedToExecute).toBeNull();

      // The rows are all still there.
      expect(await countWhere("sla_thresholds", "workspace_id", RESIDUE_A)).toBe(1);
      expect(await countWhere("crm_outbox", "workspace_id", RESIDUE_B)).toBe(1);
    },
    PG_TIMEOUT_MS,
  );

  test(
    "EXECUTE deletes the residue and leaves every sentinel standing",
    async () => {
      const promptCollectionsBefore = await countNullScope("prompt_collections", "org_id");
      const report = await sweepResidue(query, { dryRun: false });

      expect(report.errors).toEqual([]);
      expect(report.totals.rowsDeleted).toBe(3);
      expect(report.refusedToExecute).toBeNull();

      // The orphans are gone.
      expect(await countWhere("sla_thresholds", "workspace_id", RESIDUE_A)).toBe(0);
      expect(await countWhere("workspace_proactive_config", "workspace_id", RESIDUE_A)).toBe(0);
      expect(await countWhere("crm_outbox", "workspace_id", RESIDUE_B)).toBe(0);

      // The sentinels are not — with their exact counts, so a delete that took
      // one of the two `<atlas-operator>` rows would fail here.
      expect(await countWhere("sla_thresholds", "workspace_id", "_default")).toBe(1);
      expect(await countWhere("sla_thresholds", "workspace_id", "_global")).toBe(1);
      expect(await countWhere("sla_thresholds", "workspace_id", "default")).toBe(1);
      expect(await countWhere("sla_thresholds", "workspace_id", "")).toBe(1);
      expect(await countWhere("crm_outbox", "workspace_id", "<atlas-operator>")).toBe(2);

      // The NULL-scope production seed rows survive untouched.
      expect(await countNullScope("prompt_collections", "org_id")).toBe(promptCollectionsBefore);

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
      expect(report.totals.rowsWithheld).toBe(6);
    },
    PG_TIMEOUT_MS,
  );

  test(
    "a database with no organizations is refused outright, not swept",
    async () => {
      // The premise guard. With zero orgs every workspace-scoped row matches the
      // orphan predicate and the "residue" is the whole tenant dataset — the
      // shape of a wrong --database-url or a dump restored without the Better
      // Auth tables. Run last: it empties `organization`.
      await pool.query(`DELETE FROM "organization"`);
      await expect(sweepResidue(query, { dryRun: false })).rejects.toThrow(
        /organization has 0 rows/,
      );
      // ...and a DRY RUN is refused too: a preview built on a broken premise
      // would be read as a genuine finding.
      await expect(sweepResidue(query, { dryRun: true })).rejects.toThrow(/0 rows/);
      // Nothing was destroyed by the refusal.
      expect(await countWhere("sla_thresholds", "workspace_id", LIVE_ORG)).toBe(1);
    },
    PG_TIMEOUT_MS,
  );
});
