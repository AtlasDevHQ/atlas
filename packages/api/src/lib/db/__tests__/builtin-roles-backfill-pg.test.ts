/**
 * #5191 — the built-in-roles repair, against a real Postgres.
 *
 * Both halves of #5189's fix for the seeded-role freeze were asserted only as
 * TEXT before this, and both texts were green while the behaviour was
 * unverified:
 *
 *   • `migrate-pg.test.ts` runs the backfills against a fresh empty schema, so
 *     `custom_roles` has no rows and every UPDATE affects zero. That validates
 *     syntax. It cannot see whether the reconcile reconciles, nor whether
 *     `WHERE is_builtin = true` actually spares a customer's own row.
 *   • `roles.test.ts` asserts the seeder's SQL *string* contains
 *     `ON CONFLICT (org_id, name) DO UPDATE` and
 *     `WHERE custom_roles.is_builtin = true`. `createEEMock` records
 *     `{sql, params}` and never executes, so the conflict-target inference
 *     against `idx_custom_roles_org_name` and the `DO UPDATE … WHERE` filter
 *     semantics are never exercised. Replace that unique index with a PARTIAL
 *     one in some future migration and `seedBuiltinRoles` fails at runtime with
 *     *"no unique or exclusion constraint matching the ON CONFLICT
 *     specification"* — with every text assertion still passing.
 *
 * One file covers both, because they are one behaviour reached two ways: a
 * backfill repairs the workspaces that never open /admin/roles, and the seeder
 * repairs the ones that do.
 *
 * The fixture's load-bearing pair is two rows differing in exactly one column,
 * `is_builtin`, with opposite expected outcomes: the scope clause is the only
 * thing standing between our reconcile and a customer's own `analyst`
 * definition, and a fixture with only the built-in row cannot tell a
 * correctly-scoped UPDATE from `WHERE true`.
 *
 * ⚠️ FIVE things here were unfalsifiable and are called out where each is
 * fixed, because every one of them looked airtight. Three were in the first
 * draft; the last two were introduced BY THE FIXES for the first three, which
 * is the repo's own recorded lesson arriving in the file that records it:
 *
 *   1. the seeder's UPDATE arm — every built-in row present had ALREADY been
 *      reconciled by the backfill, so `SET permissions = EXCLUDED.permissions`
 *      wrote what was already there and a no-op self-assignment passed;
 *   2. two of the backfill's three statements — no `viewer` row existed, so
 *      they ran against zero rows, the gap this header criticises above;
 *   3. the idempotence check compared `updated_at` through `String(Date)`,
 *      which truncates to whole seconds — a ~2% flake, visible only in CI;
 *   4. planting the `viewer` row to fix (2) left every built-in PRESENT, so the
 *      seeder's INSERT arm was then exercised by nothing — deleting the seeder
 *      call from its own test left the suite green (fixed with `ORG_FRESH`);
 *   5. replacing (3) with `>=` on a timestamp produced an assertion equality
 *      satisfies, so removing the second seeder run entirely stayed green
 *      (fixed with `xmin`, see `readRowVersion`).
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { Pool } from "pg";
import { Effect } from "effect";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/**
 * Every builtin-roles backfill. Held back from the first migration run so the
 * stale fixture rows can be planted BEFORE they execute — running them against
 * an empty table is precisely the gap this file exists to close.
 *
 * Discovered by pattern rather than listed, so the next backfill is covered
 * the day it lands instead of the day someone remembers this file. The name
 * shape is the same one `roles.test.ts`'s drift guard keys on.
 */
const BUILTIN_ROLE_BACKFILLS = /^\d+_builtin_roles_.*\.sql$/;

// The pool `seedBuiltinRoles` will run against — assigned in `beforeAll`, so
// the mock below closes over the binding rather than the (still undefined)
// value. `getInternalDB` is called per statement, so by then it is set.
let pool: Pool;

const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => true,
  getInternalDB: () => pool,
  internalQuery: async (sql: string, params?: unknown[]) => {
    const { rows } = await pool.query(sql, params);
    return rows;
  },
}));

/**
 * The EE surface under test, loaded through a VARIABLE specifier so the type
 * checker never resolves `@atlas/ee`.
 *
 * ⚠️ `packages/api/src/**` must compile STANDALONE, without the EE package —
 * `check-ee-imports.sh` enforces that for source, and CI's "Symlink Stub Build"
 * proves it for the whole package, TESTS INCLUDED. A plain
 * `await import("@atlas/ee/auth/roles")` type-checks locally, because the api
 * tsconfig maps `@atlas/ee/*` to `../../ee/src/*` — and then fails in the stub
 * build with `TS2307: Cannot find module`. That is where this was caught; the
 * local `bun run type` cannot see it.
 *
 * ⚠️ And it must stay in `packages/api`, not move to `ee/`, even though the
 * import direction would be legal there: `test-others` deliberately does not
 * set `TEST_DATABASE_URL`, so a `-pg` suite under `ee/` would SKIP in CI
 * forever — a test that silently never runs, which is worse than the boundary
 * problem it would solve.
 *
 * Typed with the shape this file actually uses, so a change to either export
 * still surfaces here rather than degrading to `any`.
 */
interface BuiltinRoleDefinition {
  name: string;
  description: string;
  permissions: readonly string[];
}
// `: string`, not the inferred literal — a literal specifier is still resolved
// statically by TypeScript, which is the whole thing being avoided.
const EE_ROLES_MODULE: string = "@atlas/ee/auth/roles";
const { seedBuiltinRoles, BUILTIN_ROLES } = (await import(EE_ROLES_MODULE)) as {
  seedBuiltinRoles: (orgId: string) => Effect.Effect<void, Error>;
  BUILTIN_ROLES: readonly BuiltinRoleDefinition[];
};

const ORG = "org-backfill-test";
/**
 * A second workspace whose `analyst` row is OURS (`is_builtin = true`) and
 * stale. #5192's 0197 has three UPDATE statements and `ORG`'s fixture can only
 * ever exercise two: `ORG` gives `analyst` to the CUSTOMER, so our statement
 * matches zero rows there by construction. The backfills carry no `org_id`
 * filter, so a second org reaches the third statement for free.
 */
const ORG_B = "org-backfill-test-b";
/**
 * A workspace with NO rows at all — the first-ever `/admin/roles` visit.
 *
 * ⚠️ This exists because round 1's fix DELETED the seeder's INSERT coverage
 * while closing its UPDATE gap. Planting a stale built-in `viewer` in `ORG`
 * gave 0197's viewer statement a row to hit, but `viewer` was the only built-in
 * the seeder still had to insert — so afterwards every built-in was present and
 * the INSERT arm was exercised by nothing. Measured: deleting the
 * `seedBuiltinRoles` call from the insert test left the suite 9/9 green.
 */
const ORG_FRESH = "org-backfill-test-fresh";

/** The #5189-era `admin` set — eight flags, no dashboards, no share. */
const STALE_ADMIN_FLAGS = [
  "query",
  "query:raw_data",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
];

/** The pre-#5189 `viewer` set — `query` only, no dashboards flag. */
const STALE_VIEWER_FLAGS = ["query"];

/** The pre-#5189 `analyst` set — no dashboards flags. */
const STALE_ANALYST_FLAGS = ["query", "query:raw_data", "admin:audit"];

/**
 * A CUSTOMER's own role that happens to be named `analyst`. Deliberately
 * NOTHING like ours — an admin-flavoured set on a name we also use — so a
 * backfill that overwrote it would be unmistakable rather than a near-match.
 */
const CUSTOMER_ANALYST_FLAGS = ["query", "admin:users", "admin:settings"];

async function readRole(name: string, isBuiltin: boolean, org = ORG) {
  const { rows } = await pool.query<{
    permissions: string[] | string;
    description: string;
  }>(
    `SELECT permissions, description
       FROM custom_roles
      WHERE org_id = $1 AND name = $2 AND is_builtin = $3`,
    [org, name, isBuiltin],
  );
  if (!rows[0]) return null;
  const raw = rows[0].permissions;
  return {
    permissions: (typeof raw === "string" ? (JSON.parse(raw) as string[]) : raw).sort(),
    description: rows[0].description,
  };
}

/**
 * Postgres' `xmin` — the transaction that last wrote the row.
 *
 * ⚠️ NOT a timestamp, and the reason is measured. Round 1 compared `updated_at`
 * with `>=`, which equality satisfies: deleting the entire second
 * `seedBuiltinRoles` run left the test green while its comment claimed it
 * asserted the write happened. `>` is no better — `new Date().getTime()`
 * truncates Postgres' microseconds to milliseconds, so two writes inside the
 * same millisecond compare equal, which is the shape of the ~2% flake the
 * round-1 fix was closing in the first place.
 *
 * `xmin` advances on ANY update, including a no-op self-assignment, and does
 * NOT advance under `DO NOTHING`. It is the exact instrument for "the
 * `DO UPDATE` arm ran", with no clock in it at all.
 */
async function readRowVersion(name: string, isBuiltin: boolean, org = ORG): Promise<string | null> {
  const { rows } = await pool.query<{ row_version: string }>(
    `SELECT xmin::text AS row_version FROM custom_roles
      WHERE org_id = $1 AND name = $2 AND is_builtin = $3`,
    [org, name, isBuiltin],
  );
  return rows[0]?.row_version ?? null;
}

function definitionFor(name: string) {
  const def = BUILTIN_ROLES.find((r) => r.name === name);
  if (!def) throw new Error(`no BUILTIN_ROLES entry named ${name}`);
  return def;
}

describeIfPg("builtin-roles backfill + seeder (real Postgres, #5191)", () => {
  const schemaName = `roles_backfill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`builtin-roles-backfill-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // Phase 1 — everything EXCEPT the builtin-roles backfills, so the table
    // exists and is empty.
    const { readdirSync } = await import("node:fs");
    const migrationsDir = new URL("../migrations/", import.meta.url).pathname;
    const backfills = readdirSync(migrationsDir).filter((f) => BUILTIN_ROLE_BACKFILLS.test(f));
    // A zero-length list would make every assertion below vacuous — the same
    // guard `roles.test.ts` carries, for the same reason.
    expect(backfills.length).toBeGreaterThan(0);

    await runMigrations(pool, { skip: [...MANAGED_AUTH_MIGRATIONS, ...backfills] });

    // Phase 2 — plant the two rows the backfills must treat differently.
    // ⚠️ THREE rows, not two. Round 1 planted only `admin` and the customer's
    // `analyst`, which meant 0197's `viewer` and `analyst` statements still ran
    // against ZERO built-in rows — the exact gap this file's header criticises
    // `migrate-pg.test.ts` for, reproduced one layer in. Measured: adding
    // `dashboards:share` to 0197's viewer array left the suite 7/7 green.
    await pool.query(
      `INSERT INTO custom_roles (org_id, name, description, permissions, is_builtin)
       VALUES ($1, 'admin',   'stale description',          $2, true),
              ($1, 'viewer',  'stale viewer description',   $4, true),
              ($1, 'analyst', 'our own analyst, hands off', $3, false),
              ($5, 'analyst', 'stale analyst description',  $6, true)`,
      [
        ORG,
        JSON.stringify(STALE_ADMIN_FLAGS),
        JSON.stringify(CUSTOMER_ANALYST_FLAGS),
        JSON.stringify(STALE_VIEWER_FLAGS),
        ORG_B,
        JSON.stringify(STALE_ANALYST_FLAGS),
      ],
    );
    // ORG_FRESH is deliberately left EMPTY — it is the seeder's insert fixture.

    // Phase 3 — now run the backfills over rows that actually exist.
    const applied = await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    expect(applied).toBe(backfills.length);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  // ── The backfill ───────────────────────────────────────────────────

  it("reconciles a STALE built-in row to the current definition", async () => {
    const admin = await readRole("admin", true);
    expect(admin).not.toBeNull();
    // Against `BUILTIN_ROLES`, not against a literal: the property is
    // "the row agrees with the code", and a literal here would only prove the
    // backfill agrees with this test.
    expect(admin!.permissions).toEqual([...definitionFor("admin").permissions].sort());
    expect(admin!.description).toBe(definitionFor("admin").description);
  }, PG_TEST_TIMEOUT_MS);

  it("gives that row the flags it was missing", async () => {
    // Named explicitly so the failure message says WHICH flag, and so the two
    // issues that motivated the backfills each have an assertion.
    const admin = await readRole("admin", true);
    expect(admin!.permissions).toContain("dashboards:read"); // #5189
    expect(admin!.permissions).toContain("dashboards:write"); // #5189
    expect(admin!.permissions).toContain("dashboards:share"); // #5192
    // …and did not merely gain them on top of the stale set.
    expect(admin!.permissions.length).toBe(definitionFor("admin").permissions.length);
  }, PG_TEST_TIMEOUT_MS);

  it("reconciles the STALE viewer row too, not just admin", async () => {
    // 0197 has three UPDATE statements and round 1 exercised one. This is the
    // second; `analyst`'s built-in statement stays unexercised by construction,
    // because the customer owns that (org_id, name) — which is itself the
    // property the next test pins.
    const viewer = await readRole("viewer", true);
    expect(viewer).not.toBeNull();
    expect(viewer!.permissions).toEqual([...definitionFor("viewer").permissions].sort());
    expect(viewer!.permissions).toContain("dashboards:read");
    expect(viewer!.description).toBe(definitionFor("viewer").description);
  }, PG_TEST_TIMEOUT_MS);

  it("reconciles a STALE BUILT-IN analyst in another workspace", async () => {
    // 0197's third statement. `ORG` can never reach it — the customer owns that
    // (org_id, name) there — so an earlier draft called the gap "unexercised by
    // construction". True of ONE org; the backfills carry no `org_id` filter,
    // so a second workspace reaches it for free.
    const analystB = await readRole("analyst", true, ORG_B);
    expect(analystB).not.toBeNull();
    expect(analystB!.permissions).toEqual([...definitionFor("analyst").permissions].sort());
    expect(analystB!.permissions).toContain("dashboards:read");
    expect(analystB!.permissions).toContain("dashboards:write");
    // …and NOT the share flag. #5192's whole point is that `analyst` does not
    // get it, and a backfill is where a wrong array would land silently.
    expect(analystB!.permissions).not.toContain("dashboards:share");
    expect(analystB!.description).toBe(definitionFor("analyst").description);
  }, PG_TEST_TIMEOUT_MS);

  it("leaves a CUSTOMER-authored row of the same name byte-identical", async () => {
    // The one property here with a customer-data blast radius. Mutating any
    // backfill's `WHERE is_builtin = true` to `WHERE true` fails exactly this.
    const analyst = await readRole("analyst", false);
    expect(analyst).not.toBeNull();
    expect(analyst!.permissions).toEqual([...CUSTOMER_ANALYST_FLAGS].sort());
    expect(analyst!.description).toBe("our own analyst, hands off");
  }, PG_TEST_TIMEOUT_MS);

  // ── The seeder ─────────────────────────────────────────────────────

  it("seedBuiltinRoles INSERTs every built-in into a workspace with no rows", async () => {
    // ⚠️ `ORG_FRESH`, not `ORG`. In `ORG` every built-in row now exists — the
    // fixture plants two and 0197 reconciles them — so the insert arm was
    // satisfied BEFORE the seeder ran, and deleting the call left the suite
    // green. An empty workspace is the seeder's actual job: `listRoles` is its
    // only call site, i.e. someone opening /admin/roles for the first time.
    expect(await readRole("admin", true, ORG_FRESH)).toBeNull();

    await Effect.runPromise(seedBuiltinRoles(ORG_FRESH));

    for (const def of BUILTIN_ROLES) {
      const row = await readRole(def.name, true, ORG_FRESH);
      expect(row, `${def.name} was not inserted`).not.toBeNull();
      expect(row!.permissions).toEqual([...def.permissions].sort());
      expect(row!.description).toBe(def.description);
    }
    // All three, and no extras — a wrong conflict target would duplicate.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM custom_roles WHERE org_id = $1`,
      [ORG_FRESH],
    );
    expect(Number(rows[0].count)).toBe(BUILTIN_ROLES.length);
  }, PG_TEST_TIMEOUT_MS);

  it("RECONCILES a built-in row that drifted after the backfill", async () => {
    // ⚠️ The seeder's whole purpose, and round 1 could not falsify it.
    //
    // At that point the only built-in rows present had ALREADY been reconciled
    // by 0197, so `DO UPDATE SET permissions = EXCLUDED.permissions` wrote the
    // values the row already held. Measured: rewriting the SET clause to
    // `permissions = custom_roles.permissions` (a no-op self-assignment) left
    // the suite 7/7 green, and so did `DO NOTHING`. The INSERT arm was covered
    // by `viewer` and the WHERE arm by `analyst`; the UPDATE arm doing WORK was
    // covered by nothing.
    //
    // Drift the row first, then seed. This is also the real-world shape: a
    // workspace seeded before a flag existed, whose admin then opens
    // /admin/roles.
    await pool.query(
      `UPDATE custom_roles
          SET permissions = $2, description = 'drifted'
        WHERE org_id = $1 AND name = 'admin' AND is_builtin = true`,
      [ORG, JSON.stringify(STALE_ADMIN_FLAGS)],
    );
    expect((await readRole("admin", true))!.permissions).toEqual(
      [...STALE_ADMIN_FLAGS].sort(),
    );

    await Effect.runPromise(seedBuiltinRoles(ORG));

    const admin = await readRole("admin", true);
    expect(admin!.permissions).toEqual([...definitionFor("admin").permissions].sort());
    expect(admin!.description).toBe(definitionFor("admin").description);
  }, PG_TEST_TIMEOUT_MS);

  it("resolves its ON CONFLICT target against the real unique index", async () => {
    // The assertion the string test cannot make. `ON CONFLICT (org_id, name)`
    // needs `idx_custom_roles_org_name` to be a NON-partial unique index; make
    // it partial in a future migration and this throws
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification" while every text assertion stays green.
    await expect(Effect.runPromise(seedBuiltinRoles(ORG))).resolves.toBeUndefined();

    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'idx_custom_roles_org_name'`,
    );
    expect(rows[0]?.indexdef).toBeDefined();
    // Spelled out because the throw above is the real check and this is the
    // diagnosis: if it ever fires, the index grew a WHERE clause.
    expect(rows[0].indexdef).not.toContain("WHERE");
  }, PG_TEST_TIMEOUT_MS);

  it("is idempotent — a second run changes no built-in row", async () => {
    const before = await Promise.all(BUILTIN_ROLES.map((r) => readRole(r.name, true)));
    const beforeVersion = await readRowVersion("admin", true);
    await Effect.runPromise(seedBuiltinRoles(ORG));
    const after = await Promise.all(BUILTIN_ROLES.map((r) => readRole(r.name, true)));

    for (const [i, def] of BUILTIN_ROLES.entries()) {
      // Compare before-to-after INCLUDING absence. `analyst` legitimately has
      // no built-in row here: the customer's own `analyst` occupies
      // (org_id, name), the seeder's INSERT conflicts with it, and
      // `DO UPDATE … WHERE is_builtin = true` then declines to touch it — so
      // the correct outcome for that name is null both times. Asserting
      // "not null" instead treated the seeder's own scope guard as a failure.
      expect(after[i], `${def.name} changed across runs`).toEqual(before[i]);
      if (after[i]) {
        expect(after[i]!.permissions, `${def.name} drifted`).toEqual(
          [...def.permissions].sort(),
        );
      }
    }

    // …and at least one row WAS compared, or the loop above is vacuous.
    expect(after.filter(Boolean).length).toBeGreaterThan(0);

    // ⚠️ Idempotent in CONTENT, not in writes — and saying so is the point: the
    // seeder rewrites every built-in row on every run. `xmin` is what makes
    // that assertion able to FAIL. Round 1 used `updated_at` with `>=`, which
    // equality satisfies, so removing the second seeder run entirely left the
    // test green while its comment claimed the opposite.
    const afterVersion = await readRowVersion("admin", true);
    expect(beforeVersion).not.toBeNull();
    expect(afterVersion).not.toBeNull();
    expect(afterVersion).not.toBe(beforeVersion);

    const { rows } = await pool.query<{ name: string; is_builtin: boolean }>(
      `SELECT name, is_builtin FROM custom_roles WHERE org_id = $1 ORDER BY name, is_builtin`,
      [ORG],
    );
    // The exact row set, derived from the fixture rather than a count: a
    // conflict target that failed to match would INSERT a DUPLICATE rather
    // than update, and every permission assertion above would still pass on
    // whichever row came back first.
    expect(rows.map((r) => `${r.name}:${r.is_builtin}`)).toEqual([
      "admin:true",
      // Only the customer's. No built-in `analyst` beside it.
      "analyst:false",
      "viewer:true",
    ]);

    // ORG_B is untouched by ORG's seeding — the seeder is org-scoped, and a
    // missing `org_id` in its WHERE would show up here rather than as a
    // permission drift nobody notices.
    const { rows: rowsB } = await pool.query<{ name: string; is_builtin: boolean }>(
      `SELECT name, is_builtin FROM custom_roles WHERE org_id = $1 ORDER BY name`,
      [ORG_B],
    );
    expect(rowsB.map((r) => `${r.name}:${r.is_builtin}`)).toEqual(["analyst:true"]);
  }, PG_TEST_TIMEOUT_MS);

  it("still does not touch the customer's row after two seeder runs", async () => {
    // `DO UPDATE … WHERE custom_roles.is_builtin = true` is a different clause
    // from the backfill's `WHERE`, on a different statement, and it is the one
    // that runs every time somebody opens /admin/roles.
    const analyst = await readRole("analyst", false);
    expect(analyst!.permissions).toEqual([...CUSTOMER_ANALYST_FLAGS].sort());
    expect(analyst!.description).toBe("our own analyst, hands off");

    // And no built-in `analyst` was created alongside it — the conflict target
    // is (org_id, name), so ours collides with theirs and must lose.
    expect(await readRole("analyst", true)).toBeNull();
  }, PG_TEST_TIMEOUT_MS);
});
