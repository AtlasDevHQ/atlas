/**
 * LIVE-Postgres round-trip for the connection profile-tier store (#4509).
 *
 * The unit suite (`connection-profile.test.ts`) string-matches the SQL, which
 * proves intent but CANNOT prove the `ON CONFLICT (COALESCE(org_id,
 * '__self_hosted__'), install_id)` target actually matches migration 0171's
 * expression unique index — a drift there throws "no unique or exclusion
 * constraint matching the ON CONFLICT specification" only at runtime, with every
 * unit test green. This file executes the real upserts against Postgres to pin:
 *   • both tiers converge on ONE (org, install_id) row;
 *   • the baseline and LLM upserts are DISJOINT — neither clobbers the other's
 *     columns;
 *   • a re-profile FAILURE keeps the last good baseline facts + surfaces the error;
 *   • a first-ever failure is visible (error row, no success facts);
 *   • the NULL-owner (legacy self-hosted) row resolves through the COALESCE
 *     sentinel — one bucket, not one row per NULL.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset (CI sets it; opt in locally
 * with `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import type { TableProfile } from "@useatlas/types";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import {
  upsertBaselineProfile,
  recordBaselineError,
  recordLlmProfileRun,
  getConnectionProfileState,
  getBaselineProfiles,
  listConnectionProfileStates,
} from "@atlas/api/lib/semantic/connection-profile";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  console.warn(
    "connection-profile-pg: TEST_DATABASE_URL unset — skipping live profile-tier round-trip (set it to opt in).",
  );
}

const PG_TEST_TIMEOUT_MS = 30_000;

function fakeProfile(name: string): TableProfile {
  return {
    table_name: name,
    object_type: "table",
    row_count: 10,
    columns: [],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: {},
  } as unknown as TableProfile;
}

describeIfPg("connection profile-tier store — live Postgres round-trip (#4509)", () => {
  let pool: Pool;
  const schemaName = `conn_prof_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let prevDatabaseUrl: string | undefined;

  beforeAll(async () => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `connection-profile-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool as unknown as InternalPool);
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    _resetPool(null);
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(
        `connection-profile-pg: schema cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await pool.end();
  });

  it("both tiers converge on ONE row; the baseline and LLM upserts are disjoint", async () => {
    const orgId = `org-${Math.floor(Math.random() * 1e9)}`;
    const installId = "cn_prod";

    await upsertBaselineProfile({
      orgId,
      installId,
      connectionGroupId: "g_prod",
      dbType: "postgres",
      profiles: [fakeProfile("orders"), fakeProfile("customers")],
    });
    // A second upsert on the SAME (org, install) MUST hit ON CONFLICT (proves the
    // expression index matches) rather than inserting a duplicate or throwing.
    await recordLlmProfileRun({ orgId, installId, scope: { tables: ["orders"] } });

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connection_profile_state WHERE org_id = $1 AND install_id = $2`,
      [orgId, installId],
    );
    expect(rows.rows[0].n).toBe("1"); // one row, both tiers

    const state = await getConnectionProfileState(orgId, installId);
    expect(state?.baseline?.tableCount).toBe(2);
    expect(state?.baseline?.profiledAt).toBeTruthy();
    expect(state?.baselineError).toBeNull();
    expect(state?.llm?.scope).toEqual({ tables: ["orders"] });
    expect(state?.connectionGroupId).toBe("g_prod");

    // The stored payload is readable for the coverage view.
    const profiles = await getBaselineProfiles(orgId, installId);
    expect(profiles?.map((p) => p.table_name)).toEqual(["orders", "customers"]);
  });

  it("a re-profile failure keeps the last good baseline facts and surfaces the error", async () => {
    const orgId = `org-${Math.floor(Math.random() * 1e9)}`;
    const installId = "cn";
    await upsertBaselineProfile({
      orgId,
      installId,
      dbType: "postgres",
      profiles: [fakeProfile("orders")],
    });
    await recordBaselineError({ orgId, installId, dbType: "postgres", error: "permission denied later" });

    const state = await getConnectionProfileState(orgId, installId);
    expect(state?.baseline?.tableCount).toBe(1); // last good facts survive
    expect(state?.baselineError).toBe("permission denied later"); // latest failure visible
    expect((await getBaselineProfiles(orgId, installId))?.length).toBe(1);
  });

  it("a first-ever failure is visible (error row, no success facts)", async () => {
    const orgId = `org-${Math.floor(Math.random() * 1e9)}`;
    const installId = "cn_never";
    await recordBaselineError({ orgId, installId, dbType: "postgres", error: "connect ECONNREFUSED" });

    const state = await getConnectionProfileState(orgId, installId);
    expect(state?.baseline).toBeNull();
    expect(state?.baselineError).toBe("connect ECONNREFUSED");
  });

  it("the NULL-owner (legacy self-hosted) row resolves through the COALESCE sentinel", async () => {
    const installId = `cn_self_hosted_${Math.floor(Math.random() * 1e9)}`;
    await upsertBaselineProfile({
      orgId: null,
      installId,
      dbType: "postgres",
      profiles: [fakeProfile("t")],
    });
    // A second NULL-owner write on the same install MUST converge (one bucket),
    // not insert a second row — the sentinel keeps NULLs from being distinct.
    await recordLlmProfileRun({ orgId: null, installId, scope: { tables: ["t"] } });

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connection_profile_state WHERE org_id IS NULL AND install_id = $1`,
      [installId],
    );
    expect(rows.rows[0].n).toBe("1");

    const state = await getConnectionProfileState(null, installId);
    expect(state?.baseline?.tableCount).toBe(1);
    expect(state?.llm?.scope).toEqual({ tables: ["t"] });
  });

  it("listConnectionProfileStates scopes to the workspace", async () => {
    const orgId = `org-${Math.floor(Math.random() * 1e9)}`;
    await upsertBaselineProfile({ orgId, installId: "a", dbType: "postgres", profiles: [] });
    await upsertBaselineProfile({ orgId, installId: "b", dbType: "postgres", profiles: [fakeProfile("x")] });

    const states = await listConnectionProfileStates(orgId);
    expect(states.map((s) => s.installId).sort()).toEqual(["a", "b"]);
    expect(states.every((s) => s.orgId === orgId)).toBe(true);
  });
});
