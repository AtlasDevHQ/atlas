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
 * Six properties make this able to fail:
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
 *  5. **Only a real RELATION can falsify the relkind arm.** The unit fakes
 *     answer from a fixture, not from the query's WHERE clause, so restoring
 *     `AND c.relkind = 'r'` leaves them 49/49 green — measured. The VIEW test
 *     below turns a purged-class name into an actual view and is the only thing
 *     that reddens.
 *  6. **Only a real restricted ROLE can falsify the privilege arm.** As the
 *     owner, `information_schema` and `pg_catalog` agree on every row, so an
 *     owner-only suite cannot tell them apart — measured: reverting discovery to
 *     `information_schema` leaves every other test here green.
 *
 * A private scratch DATABASE, not a scratch schema: the sweep hardcodes
 * `public` (as `ops wipe` and the runbook query do), and this suite runs a
 * DESTRUCTIVE delete. Pointing it at the shared test database's `public` schema
 * would put a sibling suite's rows in the blast radius.
 *
 * ⚠️ **ALL of these tests are ORDER-COUPLED through shared database state.**
 * The two schema-mutating ones (the VIEW test, the restricted-role test)
 * restore what they change and must precede the destructive ones; then
 * discovery → DRY RUN (asserts rows present) → EXECUTE (deletes them) →
 * idempotency (asserts the delete stuck); and the no-organizations test empties
 * `organization`, so it must run LAST. bun runs them in declaration order, so a
 * full-file run is correct; `bun test -t <name>` on any single one is not.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset. Requires a role with
 * **CREATEDB and CREATEROLE** (CI's `atlas` role is superuser and has both) —
 * the privilege falsifier creates and drops a login role, and needs a `pg_hba`
 * that permits that role's password login from the test host. CI's api-tests
 * workflow provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { runMigrations, runSeeds } from "@atlas/api/lib/db/migrate";
import {
  discoverResidueTargets,
  enumerateOrphanValues,
  executeResidueDeletes,
  isBenignSkip,
  planResidueSweep,
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
      // As the OWNER, nothing is unreadable. This is a control, not the
      // privilege falsifier — measured, it stays green with discovery reverted
      // to `information_schema`, because owner and catalog agree on every row.
      // The falsifier that CAN fail is the restricted-role test below.
      expect(skipped.filter((s) => !isBenignSkip(s))).toEqual([]);
    },
    PG_TIMEOUT_MS,
  );

  test(
    "a purged-class name that is a VIEW is `unreadable`, not `relation-absent`",
    async () => {
      // ⚠️ Only a real relation can falsify this. `relkind` used to be filtered
      // in the WHERE clause, so a view — or a PARTITIONED table, which is the
      // realistic case for `messages`/`agent_runs`/`audit_log` — returned zero
      // catalog rows and read as "relation absent — run the region's
      // migrations": benign, exit 0, and a remedy that can never work. The unit
      // fakes cannot catch that: they answer from a fixture, not from the WHERE
      // clause, so reverting the SQL leaves them green (measured).
      //
      // `linear_installations` is a `purged` table this fixture never otherwise
      // touches, and this runs before the destructive tests below.
      await pool.query(`DROP TABLE IF EXISTS linear_installations CASCADE`);
      await pool.query(
        `CREATE VIEW linear_installations AS SELECT 'never'::text AS org_id`,
      );

      const { targets, skipped } = await discoverResidueTargets(query);
      const asView = skipped.find((s) => s.table === "linear_installations");

      expect(targets.some((t) => t.table === "linear_installations")).toBe(false);
      expect(asView?.kind).toBe("unreadable");
      expect(asView?.reason).toContain('relkind "v"');
      expect(asView && isBenignSkip(asView)).toBe(false);

      await pool.query(`DROP VIEW IF EXISTS linear_installations`);
      await pool.query(
        `CREATE TABLE linear_installations (org_id TEXT PRIMARY KEY, installed_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
    },
    PG_TIMEOUT_MS,
  );

  test(
    "a role that cannot read a table gets `unreadable`, never a benign skip",
    async () => {
      // ⚠️ THE privilege falsifier, and it needs a real restricted role — the
      // owner sees the same thing through `information_schema` and `pg_catalog`,
      // so an owner-only suite cannot tell the two apart. Measured before this
      // test existed: reverting discovery to `information_schema` left the whole
      // `-pg` suite green while a column-grant role got
      // `kind: "no-scope-column"` — benign, exit 0, and a remedy ("resolve it
      // through the parent table") that can never work.
      const role = `residue_reader_${Math.floor(Math.random() * 1e6)}`;
      const restricted = new Pool({
        connectionString: (() => {
          const u = new URL(TEST_DB_URL as string);
          u.pathname = `/${scratchDbName}`;
          u.username = role;
          u.password = "probe";
          return u.toString();
        })(),
        max: 1,
      });
      try {
        await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`);
        await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        // The scope column is deliberately EXCLUDED from the grant.
        await pool.query(`GRANT SELECT (latency_p99_ms) ON public.sla_thresholds TO ${role}`);
        await pool.query(`GRANT SELECT ON public.organization TO ${role}`);

        const restrictedQuery = (async (sql: string, params?: unknown[]) =>
          (await restricted.query<Record<string, unknown>>(sql, params)).rows) as ResidueQuery;

        const { targets, skipped } = await discoverResidueTargets(restrictedQuery);
        // The catalog is privilege-blind, so the scope column is still FOUND —
        // "this table has no scope column" stays a structural fact.
        expect(targets).toContainEqual({ table: "sla_thresholds", column: "workspace_id" });
        expect(skipped.find((s) => s.table === "sla_thresholds")).toBeUndefined();

        // The privilege problem then surfaces where it is MEASURED rather than
        // inferred: the orphan query fails, and that is `unreadable`.
        const { orphans, skipped: querySkips } = await enumerateOrphanValues(restrictedQuery, [
          { table: "sla_thresholds", column: "workspace_id" },
        ]);
        expect(orphans).toEqual([]);
        expect(querySkips[0]?.kind).toBe("unreadable");
        expect(querySkips[0]?.reason).toContain("permission denied");
        expect(querySkips[0] && isBenignSkip(querySkips[0])).toBe(false);
      } finally {
        await restricted.end().catch((err: unknown) => {
          console.warn(
            `residue-sweep-pg: restricted pool end failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        await pool
          .query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`)
          .catch((err: unknown) => {
            console.warn(
              `residue-sweep-pg: revoke failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        await pool.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`).catch((err: unknown) => {
          // Logged like its two neighbours. The marker it used to carry means
          // SILENCE, and nothing distinguished this teardown step from the
          // REVOKE and DROP around it, both of which warn.
          console.warn(
            `residue-sweep-pg: revoke usage failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        await pool.query(`DROP ROLE IF EXISTS ${role}`).catch((err: unknown) => {
          console.warn(
            `residue-sweep-pg: drop role failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
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

      // ⚠️ And `executeResidueDeletes` carries the premise ITSELF — AUDIBLY.
      // It is exported and callable without `sweepResidue`'s guard, and with an
      // empty `organization` its SQL `NOT EXISTS (o.id = …)` clause is vacuously
      // true for every row, so the orphan re-check alone protected nothing in
      // exactly the state it was written for.
      //
      // The SQL `AND EXISTS (SELECT 1 FROM public.organization)` clause is still
      // there as defence in depth, but on its own it is NOT enough: when it is
      // what zeroes the delete, the outcome is `{deletions:[{deletedRows:0}],
      // errors:[]}` — the SUCCESS shape, exit 0. The guard would fire and nobody
      // would be told, which is this module's whole subject. So it REFUSES.
      // Every remaining row here belongs to a workspace whose organization row
      // is gone, so a missing guard deletes real data.
      const before = await countWhere("sla_thresholds", "workspace_id", LIVE_ORG);
      await expect(
        executeResidueDeletes(
          query,
          planResidueSweep([
            { table: "sla_thresholds", column: "workspace_id", value: LIVE_ORG, rows: 1 },
          ]).deletable,
        ),
      ).rejects.toThrow(/organization has 0 rows/);
      expect(await countWhere("sla_thresholds", "workspace_id", LIVE_ORG)).toBe(before);
    },
    PG_TIMEOUT_MS,
  );
});
