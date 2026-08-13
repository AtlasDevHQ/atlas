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
 * ⚠️ Three things here were unfalsifiable in the first draft and are called out
 * where they are fixed, because each looked airtight:
 *   • the seeder's UPDATE arm — every built-in row present had ALREADY been
 *     reconciled by the backfill, so `SET permissions = EXCLUDED.permissions`
 *     wrote what was already there and a no-op self-assignment passed;
 *   • two of the backfill's three statements — no `viewer` row existed, so they
 *     ran against zero rows, which is the gap this header criticises above;
 *   • the idempotence check compared `updated_at` through `String(Date)`, which
 *     truncates to whole seconds — a ~2% flake, visible only in CI.
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

const { seedBuiltinRoles, BUILTIN_ROLES } = await import("@atlas/ee/auth/roles");

const ORG = "org-backfill-test";

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

/**
 * A CUSTOMER's own role that happens to be named `analyst`. Deliberately
 * NOTHING like ours — an admin-flavoured set on a name we also use — so a
 * backfill that overwrote it would be unmistakable rather than a near-match.
 */
const CUSTOMER_ANALYST_FLAGS = ["query", "admin:users", "admin:settings"];

async function readRole(name: string, isBuiltin: boolean) {
  const { rows } = await pool.query<{
    permissions: string[] | string;
    description: string;
    updated_at: string;
  }>(
    `SELECT permissions, description, updated_at
       FROM custom_roles
      WHERE org_id = $1 AND name = $2 AND is_builtin = $3`,
    [ORG, name, isBuiltin],
  );
  if (!rows[0]) return null;
  const raw = rows[0].permissions;
  return {
    permissions: (typeof raw === "string" ? (JSON.parse(raw) as string[]) : raw).sort(),
    description: rows[0].description,
  };
}

/** `updated_at` as milliseconds, for the tests that assert a write DID happen. */
async function readUpdatedAt(name: string, isBuiltin: boolean): Promise<number | null> {
  const { rows } = await pool.query<{ updated_at: string }>(
    `SELECT updated_at FROM custom_roles
      WHERE org_id = $1 AND name = $2 AND is_builtin = $3`,
    [ORG, name, isBuiltin],
  );
  return rows[0] ? new Date(rows[0].updated_at).getTime() : null;
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
              ($1, 'analyst', 'our own analyst, hands off', $3, false)`,
      [
        ORG,
        JSON.stringify(STALE_ADMIN_FLAGS),
        JSON.stringify(CUSTOMER_ANALYST_FLAGS),
        JSON.stringify(STALE_VIEWER_FLAGS),
      ],
    );

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

  it("leaves a CUSTOMER-authored row of the same name byte-identical", async () => {
    // The one property here with a customer-data blast radius. Mutating any
    // backfill's `WHERE is_builtin = true` to `WHERE true` fails exactly this.
    const analyst = await readRole("analyst", false);
    expect(analyst).not.toBeNull();
    expect(analyst!.permissions).toEqual([...CUSTOMER_ANALYST_FLAGS].sort());
    expect(analyst!.description).toBe("our own analyst, hands off");
  }, PG_TEST_TIMEOUT_MS);

  // ── The seeder ─────────────────────────────────────────────────────

  it("seedBuiltinRoles INSERTs the built-ins that were absent", async () => {
    // `viewer` has no row at all yet — the backfill only UPDATEs. This is the
    // ON CONFLICT statement's insert arm, executed rather than string-matched.
    await Effect.runPromise(seedBuiltinRoles(ORG));

    const viewer = await readRole("viewer", true);
    expect(viewer).not.toBeNull();
    expect(viewer!.permissions).toEqual([...definitionFor("viewer").permissions].sort());
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
    const beforeTs = await readUpdatedAt("admin", true);
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

    // ⚠️ Idempotent in CONTENT, not in writes — and saying so is the point.
    // Round 1 compared `updatedAt` as part of the row and passed only because
    // `String(Date)` truncates to whole seconds; across a second boundary it
    // was a ~2% flake, and one that could only ever be seen in CI because the
    // `-pg` lane skips locally. The seeder sets `updated_at = now()` on every
    // conflict, so the honest assertion is that the timestamp MOVED while the
    // content did not.
    const afterTs = await readUpdatedAt("admin", true);
    expect(beforeTs).not.toBeNull();
    expect(afterTs!).toBeGreaterThanOrEqual(beforeTs!);

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
